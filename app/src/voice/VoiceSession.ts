import { AudioTurns, pcm16, SAMPLE_RATE } from "./audio";
import { WakeDetector, type WakeDiagnostic } from "./WakeDetector";

export type VoiceStatus = "idle" | "wake" | "armed" | "loading" | "listening" | "stopping" | "error";
export type TranscriptEvent = { type: string; item_id?: string; delta?: string; transcript?: string };
type VoiceEvents = {
  status: (status: VoiceStatus, detail?: string) => void;
  transcript: (event: TranscriptEvent) => void;
  awake?: () => void;
  wakeDetected?: (diagnostic?: WakeDiagnostic) => void;
  activity?: (level: number, speaking: boolean) => void;
  /** What was just heard turned out to be background sound; drop any draft of it. */
  discard?: () => void;
};

export class VoiceSession {
  private disposed = false;
  private stopping = false;
  private turns = new AudioTurns();
  private wake?: WakeDetector;
  private awake = false;
  private wakeDeadline = 0;
  private replyPlaying = false;
  private playbackUntil = 0;
  private muteTranscriptUntil = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private capture?: AudioWorkletNode;
  private socket?: WebSocket;
  private ready = false;
  private speaking = false;
  private queued: (ArrayBuffer | string)[] = [];
  private queuedBytes = 0;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private connectionAttempts = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private events: VoiceEvents, private options: { wake?: boolean; automatic?: boolean } = {}) {}

  async start() {
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
          !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
        throw new Error("Voice needs microphone and AudioWorklet support. Open the app on localhost or HTTPS.");
      }
      this.events.status("loading", "Allow microphone access. Sound detection runs locally until you speak.");
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      if (!this.options.wake) await this.context.resume();
      if (this.disposed) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        // Echo cancellation removes what this browser itself is playing (a video
        // in the app, spoken replies). Voice isolation, where the system offers
        // it, also suppresses other sound in the room; unsupported, it is ignored.
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true } as MediaTrackConstraints,
      });
      if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      if (this.options.wake) {
        let resumeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.context.resume(), new Promise((_, reject) => {
            resumeTimer = setTimeout(() => reject(new Error(this.options.automatic
              ? 'Your browser needs one tap before audio can start. Tap the orb, then say Marbles.'
              : 'Your browser needs one click to enable wake listening. Use Enable microphone.')), 2500);
          })]);
        } finally { clearTimeout(resumeTimer); }
        if (this.disposed) return;
      }
      stream.getAudioTracks()[0].onended = () => this.fail("Microphone disconnected. Reconnect it and try again.");
      if (this.context.sampleRate !== SAMPLE_RATE) throw new Error("This browser cannot capture 24 kHz audio. Try recent Chrome or Edge.");
      await this.context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url).href);
      if (this.disposed) return;
      if (this.options.wake) {
        this.wake = new WakeDetector((audio, diagnostic) => {
          if (this.disposed || this.stopping || this.replyPlaying || performance.now() < this.playbackUntil || this.awake) return;
          this.events.wakeDetected?.(diagnostic);
          this.events.awake?.();
          this.replyPlaying = false; this.playbackUntil = 0;
          this.awake = true; this.wakeDeadline = Date.now() + 20_000;
          this.events.status('armed', 'Marbles heard. Describe your task.');
          this.turns.begin(audio.length);
          this.speaking = true;
          this.events.activity?.(0.5, true);
          if (!this.socket) this.connect();
          this.sendRaw(pcm16(audio));
        }, message => this.fail(message));
        this.events.status('loading', 'Loading the local Marbles detector…');
        this.armTimeout('Wake model download timed out. Check your connection and try again.', 180_000);
        await this.wake.load(percent => this.events.status('loading', `Downloading local wake model: ${percent}%`));
        clearTimeout(this.timer);
        if (this.disposed) return;
      }
      this.listen();
    } catch (error) {
      if (!this.disposed) this.fail(error instanceof Error && error.name === "NotAllowedError"
        ? "Microphone access was blocked. Allow it in your browser settings and try again."
        : error instanceof Error ? error.message : String(error));
    }
  }

  private listen() {
    this.source = this.context!.createMediaStreamSource(this.stream!);
    this.capture = new AudioWorkletNode(this.context!, "voice-capture");
    this.capture.port.onmessage = ({ data }: MessageEvent<Float32Array | null>) => {
      if (this.disposed) return;
      try {
        if (data === null) {
          this.releaseMicrophone();
          if (this.turns.flush()) this.send({ type: "commit" });
          if (this.socket) this.send({ type: "finish" });
          else { this.dispose(); this.events.status("idle", "Microphone off. No audio was sent."); }
        } else this.consume(data);
      } catch { this.fail("Voice connection was interrupted. Please try again."); }
    };
    this.source.connect(this.capture);
    this.capture.connect(this.context!.destination); // Worklet output is silent.
    if (this.options.wake) this.rearm();
    else this.events.status("armed", "Microphone on. Stay quiet briefly, then speak to wake transcription.");
  }

  private consume(data: Float32Array) {
    // Do not feed our own voice back into either recognizer. The browser's
    // recognizer has a separate microphone path, so its callback is gated too.
    if (this.replyPlaying || performance.now() < this.playbackUntil) return;
    this.wake?.setSuspended(false);
    // Expire before inspecting new speech, so a voice starting after the
    // listening window cannot extend it without another wake word.
    if (this.options.wake && this.awake && !this.speaking && Date.now() > this.wakeDeadline) this.rearm();
    if (this.wake && !this.awake) {
      this.wake.push(data);
      const rms = Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
      this.events.activity?.(Math.min(1, rms * 12), false);
      return;
    }
    const turn = this.turns.push(data);
    this.events.activity?.(turn.level, turn.speaking);
    const started = turn.speaking && !this.speaking;
    this.speaking = turn.speaking;
    if (turn.background) {
      // Music or a video, not a request: close the turn, ignore whatever
      // transcript it produces, and go back to waiting for the wake word
      // instead of streaming the room to the transcriber.
      this.send({ type: 'commit' });
      this.muteTranscriptUntil = performance.now() + 6000;
      this.events.discard?.();
      this.rearm();
      return;
    }
    // Only speech inside an explicitly awakened turn can extend its window.
    if (turn.audio) {
      if (started) this.wakeDeadline = Math.max(this.wakeDeadline, Date.now() + 15_000);
      if ((this.socket?.bufferedAmount ?? 0) > SAMPLE_RATE * 2 * 3) {
        this.fail('Connection cannot keep up. Recording stopped; please try again.'); return;
      }
      if (!this.socket) this.connect();
      this.sendRaw(pcm16(turn.audio));
    }
    if (turn.commit) this.send({ type: 'commit' });
    if (this.options.wake && Date.now() > this.wakeDeadline && !this.speaking) this.rearm();
    else if (this.ready && !this.stopping) this.reportActivity();
  }

  rearm() {
    if (!this.options.wake || this.disposed || this.stopping) return;
    if (this.turns.flush()) this.send({ type: 'commit' });
    this.turns.discard(); this.wake?.reset();
    this.speaking = false;
    this.events.activity?.(0, false);
    this.awake = false;
    this.wakeDeadline = 0;
    this.events.status('wake', this.wake?.browserRecognitionActive
      ? 'Listening for Marbles with local and browser speech recognition.'
      : 'Listening locally for Marbles. Standby audio stays on this device.');
  }

  /** Attention can only shorten a quiet, explicitly awakened listening window.
   * Looking at the screen is never permission to transcribe the room. */
  setAttention(looking: boolean | null) {
    if (looking !== false || !this.options.wake || this.disposed || this.stopping || !this.capture) return;
    if (this.awake && !this.speaking) {
      this.wakeDeadline = Math.min(this.wakeDeadline, Date.now() + 3000);
    }
  }

  setReplyPlaying(playing: boolean) {
    if (playing === this.replyPlaying) return;
    this.replyPlaying = playing;
    this.playbackUntil = playing ? Infinity : performance.now() + 350;
    if (playing) this.wake?.setSuspended(true);
    this.turns.discard(); this.wake?.reset();
  }

  private reportActivity() {
    if (this.options.wake && !this.awake) {
      this.events.status('wake', 'Listening for Marbles.'); return;
    }
    this.events.status(this.speaking ? "listening" : "armed", this.speaking
      ? "Transcribing with OpenAI. Your audio is being sent."
      : "Waiting for your voice. Quiet audio stays on this device.");
  }

  private connect() {
    this.events.status("loading", "Voice detected. Connecting to OpenAI…");
    this.armTimeout("Connection timed out. Check your server and API key.", 20_000);
    const url = new URL("/api/voice", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    this.connectionAttempts++;
    let retrying = false;
    const connectionFailed = () => {
      if (this.disposed || this.socket !== socket || retrying) return;
      if (!this.ready && this.connectionAttempts < 3 && !this.stopping) {
        retrying = true;
        socket.onerror = socket.onclose = socket.onmessage = null;
        socket.close();
        this.events.status('loading', 'Reconnecting to the local voice server…');
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          if (!this.disposed) this.connect();
        }, this.connectionAttempts * 500);
        return;
      }
      this.fail(this.ready ? 'Voice connection closed. Please try again.'
        : 'The local voice server refused the connection. Close other Marbles tabs using voice, or restart the app server.');
    };
    socket.onerror = connectionFailed;
    socket.onclose = connectionFailed;
    this.socket.onmessage = ({ data }) => {
      if (this.disposed) return;
      try {
        const event = JSON.parse(data);
        if (event.type === "ready") {
          this.ready = true;
          this.connectionAttempts = 0;
          clearTimeout(this.timer);
          this.drain();
          if (this.stopping) this.armTimeout("Final transcription timed out. You can copy the text received so far.", 15_000);
          else this.reportActivity();
        } else if (event.type === "error") this.fail(event.message);
        else if (event.type === "finished") {
          this.dispose();
          this.events.status("idle", "Transcript ready. Microphone off.");
        } else if (performance.now() >= this.muteTranscriptUntil) this.events.transcript(event);
      } catch { this.fail("Invalid voice response. Please reconnect."); }
    };
  }

  private sendRaw(chunk: ArrayBuffer | string) {
    if (this.disposed) return;
    this.queuedBytes += typeof chunk === "string" ? chunk.length : chunk.byteLength;
    if (this.queuedBytes > SAMPLE_RATE * 2 * 8) {
      this.fail("OpenAI is taking too long to connect. Please try again.");
      return;
    }
    if (typeof chunk === 'string') this.queued.push(chunk);
    else for (let start = 0; start < chunk.byteLength; start += 9600) this.queued.push(chunk.slice(start, start + 9600));
    this.drain();
  }

  private drain() {
    if (!this.ready || this.disposed || this.sendTimer || !this.queued.length) return;
    if (this.socket!.bufferedAmount > SAMPLE_RATE * 2 * 3) {
      this.fail('Voice connection cannot keep up. Please try again.'); return;
    }
    const chunk = this.queued.shift()!;
    this.queuedBytes -= typeof chunk === 'string' ? chunk.length : chunk.byteLength;
    this.socket!.send(chunk);
    // Pace the initial pre-roll / connection backlog instead of flooding the
    // upstream socket with several seconds of buffered audio in one event loop.
    this.sendTimer = setTimeout(() => { this.sendTimer = undefined; this.drain(); }, 20);
  }

  private send(event: { type: string }) { this.sendRaw(JSON.stringify(event)); }

  stop() {
    if (this.disposed || this.stopping) return;
    if (!this.capture) { this.dispose(); this.events.status("idle", "Start cancelled."); return; }
    this.stopping = true;
    this.events.status("stopping", "Finishing the last words…");
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.armTimeout("Final transcription timed out. The text received so far is available to copy.", 15_000);
    this.capture.port.postMessage("flush");
  }

  private armTimeout(message: string, ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(message), ms);
  }

  private fail(message: string) {
    if (this.disposed) return;
    this.dispose();
    this.events.status("error", message);
  }

  private releaseMicrophone() {
    this.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.source?.disconnect();
    this.capture?.disconnect();
    if (this.capture) this.capture.port.onmessage = null;
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.sendTimer);
    clearTimeout(this.reconnectTimer);
    this.wake?.dispose();
    this.releaseMicrophone();
    this.events.activity?.(0, false);
    this.queued = [];
    this.queuedBytes = 0;
    if (this.socket) {
      this.socket.onclose = this.socket.onerror = this.socket.onmessage = null;
      this.socket.close();
    }
  }
}
