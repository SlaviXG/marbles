import { AudioTurns, pcm16, SAMPLE_RATE } from "./audio";

export type VoiceStatus = "idle" | "loading" | "listening" | "stopping" | "error";
export type TranscriptEvent = { type: string; item_id?: string; delta?: string; transcript?: string };
type VoiceEvents = {
  status: (status: VoiceStatus, detail?: string) => void;
  transcript: (event: TranscriptEvent) => void;
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
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private events: VoiceEvents) {}

  async start() {
    try {
      if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia ||
          !globalThis.AudioContext || !globalThis.AudioWorkletNode) {
        throw new Error("Voice needs microphone and AudioWorklet support. Open the app on localhost or HTTPS.");
      }
      this.events.status("loading", "Allow microphone access to connect to OpenAI.");
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
          if (event.type === "ready") { clearTimeout(this.timer); this.listen(); }
          else if (event.type === "error") this.fail(event.message);
          else if (event.type === "finished") {
            this.dispose();
            this.events.status("idle", "Transcript ready. Audio was sent to OpenAI.");
          } else this.events.transcript(event);
        } catch { this.fail("Invalid voice response. Please reconnect."); }
      };
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
          this.send({ type: "finish" });
        } else {
          const turn = this.turns.push(data);
          if (turn.audio) {
            if (this.socket!.bufferedAmount > SAMPLE_RATE * 2 * 3) {
              this.fail("Connection cannot keep up. Recording stopped; try again on a faster connection.");
              return;
            }
            this.socket!.send(pcm16(turn.audio));
          }
          if (turn.commit) this.send({ type: "commit" });
        }
      } catch { this.fail("Voice connection was interrupted. Please try again."); }
    };
    this.source.connect(this.capture);
    this.capture.connect(this.context!.destination); // Worklet output is silent.
    this.events.status("listening", "Listening. Audio is sent to OpenAI for live transcription.");
  }

  private send(event: { type: string }) { this.socket!.send(JSON.stringify(event)); }

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
    this.releaseMicrophone();
    if (this.socket) {
      this.socket.onclose = this.socket.onerror = this.socket.onmessage = null;
      this.socket.close();
    }
  }
}
