import { AudioTurns, pcm16, SAMPLE_RATE } from "./audio";

export type VoiceStatus = "idle" | "armed" | "loading" | "listening" | "stopping" | "error";
export type TranscriptEvent = { type: string; item_id?: string; delta?: string; transcript?: string };
type VoiceEvents = {
  status: (status: VoiceStatus, detail?: string) => void;
  transcript: (event: TranscriptEvent) => void;
  activity?: (level: number, speaking: boolean) => void;
};

export class VoiceSession {
  private disposed = false;
  private stopping = false;
  private turns = new AudioTurns();
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
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private events: VoiceEvents) {}

  async start() {
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
          !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
        throw new Error("Voice needs microphone and AudioWorklet support. Open the app on localhost or HTTPS.");
      }
      this.events.status("loading", "Allow microphone access. Sound detection runs locally until you speak.");
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
      await this.context.resume();
      if (this.disposed) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (this.disposed) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      stream.getAudioTracks()[0].onended = () => this.fail("Microphone disconnected. Reconnect it and try again.");
      if (this.context.sampleRate !== SAMPLE_RATE) throw new Error("This browser cannot capture 24 kHz audio. Try recent Chrome or Edge.");
      await this.context.audioWorklet.addModule(new URL("./capture.worklet.js", import.meta.url).href);
      if (this.disposed) return;
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
        } else {
          const turn = this.turns.push(data);
          this.events.activity?.(turn.level, turn.speaking);
          this.speaking = turn.speaking;
          if (turn.audio) {
            if ((this.socket?.bufferedAmount ?? 0) > SAMPLE_RATE * 2 * 3) {
              this.fail("Connection cannot keep up. Recording stopped; try again on a faster connection.");
              return;
            }
            if (!this.socket) this.connect();
            this.sendRaw(pcm16(turn.audio));
          }
          if (turn.commit) this.send({ type: "commit" });
          if (this.ready && !this.stopping) this.reportActivity();
        }
      } catch { this.fail("Voice connection was interrupted. Please try again."); }
    };
    this.source.connect(this.capture);
    this.capture.connect(this.context!.destination); // Worklet output is silent.
    this.events.status("armed", "Microphone on. Stay quiet briefly, then speak to wake transcription.");
  }

  private reportActivity() {
    this.events.status(this.speaking ? "listening" : "armed", this.speaking
      ? "Transcribing with OpenAI. Your audio is being sent."
      : "Waiting for your voice. Quiet audio stays on this device.");
  }

  private connect() {
    this.events.status("loading", "Voice detected. Connecting to OpenAI…");
    this.armTimeout("Connection timed out. Check your server and API key.", 20_000);
    const url = new URL("/api/voice", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new WebSocket(url);
    this.socket.onerror = () => this.fail("Cannot connect to voice. Check the app server and OPENAI_API_KEY.");
    this.socket.onclose = () => this.fail("Voice connection closed. Try again.");
    this.socket.onmessage = ({ data }) => {
      if (this.disposed) return;
      try {
        const event = JSON.parse(data);
        if (event.type === "ready") {
          this.ready = true;
          clearTimeout(this.timer);
          this.drain();
          if (this.stopping) this.armTimeout("Final transcription timed out. You can copy the text received so far.", 15_000);
          else this.reportActivity();
        } else if (event.type === "error") this.fail(event.message);
        else if (event.type === "finished") {
          this.dispose();
          this.events.status("idle", "Transcript ready. Microphone off.");
        } else this.events.transcript(event);
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
