import { SAMPLE_RATE } from './audio';
import { wakeMatch } from './wakePhrase';
import { WAKE_COOLDOWN_MS, WAKE_FINAL_PAD_SECONDS, WAKE_HANGOVER_SECONDS, WAKE_HISTORY_SECONDS, WAKE_HOP_SECONDS, WAKE_MAX_FAILURES, WAKE_MIN_RMS, WAKE_NOISE_ADAPTATION, WAKE_NOISE_MULTIPLIER, WAKE_PREROLL_SECONDS, WAKE_RETRY_MS, WAKE_START_MARGIN_SECONDS, WAKE_WEB_SPEECH_ENABLED, WAKE_WINDOW_SECONDS } from './wakeConfig';

export type WakeDiagnostic = { latencyMs: number; text: string; score: number; detector: 'whisper' | 'webspeech'; inferenceMs: number; droppedWindows: number };
type Job = { audio: Float32Array; end: number; length: number; epoch: number };
type SpeechResult = { isFinal: boolean; [index: number]: { transcript: string } };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type Recognition = { continuous: boolean; interimResults: boolean; lang: string; onresult: ((event: SpeechEvent) => void) | null; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null; start: () => void; stop: () => void };

function downsample(window: Float32Array): Float32Array {
  const samples = new Float32Array(Math.floor(window.length * 2 / 3));
  for (let i = 0; i < samples.length; i++) {
    const start = i * 1.5, end = start + 1.5;
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += window[j] * (Math.min(end, j + 1) - Math.max(start, j));
    samples[i] = sum / 1.5;
  }
  return samples;
}

export class WakeDetector {
  private worker?: Worker;
  private recognition?: Recognition;
  private audio = new Float32Array(0);
  private total = 0;
  private noise = 0.001;
  private voiceOnset = 0;
  private lastVoiceEnd = 0;
  private lastScheduled = 0;
  private finalScheduled = false;
  private busy = false;
  private pending?: Job;
  private epoch = 0;
  private disposed = false;
  private loaded = false;
  private suspended = false;
  private failures = 0;
  private retryAt = 0;
  private cooldownUntil = 0;
  private droppedWindows = 0;
  private rejectLoad?: (error: Error) => void;
  constructor(private wake: (audio: Float32Array, diagnostic: WakeDiagnostic) => void, private error: (message: string) => void) {}

  get browserRecognitionActive() { return this.recognition !== undefined; }
  setSuspended(value: boolean) {
    if (value === this.suspended) return;
    this.suspended = value; this.reset();
    if (value) {
      const recognition = this.recognition; this.recognition = undefined;
      try { recognition?.stop(); } catch { /* Already stopped. */ }
    } else if (this.loaded && !this.disposed) this.startWebSpeech();
  }

  load(progress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectLoad = reject;
      this.worker = new Worker(new URL('./wake.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onerror = event => {
        const detail = event.message || 'The browser stopped the wake worker.';
        if (!this.loaded) reject(new Error(`Wake model could not start: ${detail}`));
        else this.error(`Wake worker stopped: ${detail}. Use Enable microphone to retry.`);
      };
      this.worker.onmessage = ({ data }) => {
        if (this.disposed) return;
        if (data.type === 'ready') { this.loaded = true; this.rejectLoad = undefined; this.startWebSpeech(); resolve(); }
        else if (data.type === 'progress') progress(data.progress);
        else if (data.type === 'error') {
          this.busy = false;
          const detail = typeof data.message === 'string' ? data.message.slice(0, 300) : 'Unknown local model error';
          if (!this.loaded || data.phase === 'load') { reject(new Error(`Wake model could not load: ${detail}`)); return; }
          console.warn('Local wake inference failed:', detail);
          this.failures++; this.retryAt = Date.now() + WAKE_RETRY_MS; this.pending = undefined;
          if (this.failures >= WAKE_MAX_FAILURES) this.error(`Wake recognition failed repeatedly: ${detail}. Use Enable microphone to retry.`);
        } else if (data.type === 'result') {
          this.busy = false; this.failures = 0;
          if (data.epoch === this.epoch && typeof data.text === 'string' && Number.isFinite(data.start))
            this.detect('whisper', data.text, data.start, data.inferenceMs ?? 0, data.end, data.length);
          this.dispatchPending();
        }
      };
      this.worker.postMessage({ type: 'load' });
    });
  }

  push(audio: Float32Array) {
    if (this.disposed || this.suspended || !this.loaded || !audio.length || !audio.every(Number.isFinite)) return;
    const joined = new Float32Array(this.audio.length + audio.length);
    joined.set(this.audio); joined.set(audio, this.audio.length);
    this.audio = joined.slice(-SAMPLE_RATE * WAKE_HISTORY_SECONDS);
    const before = this.total;
    this.total += audio.length;
    const rms = Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length);
    const voiced = rms >= Math.max(WAKE_MIN_RMS, this.noise * WAKE_NOISE_MULTIPLIER);
    if (voiced) {
      if (!this.lastVoiceEnd || before - this.lastVoiceEnd > SAMPLE_RATE * WAKE_HANGOVER_SECONDS) {
        this.voiceOnset = before; this.lastScheduled = 0; this.finalScheduled = false;
      }
      this.lastVoiceEnd = this.total;
    } else this.noise += (Math.min(rms, this.noise * 1.5) - this.noise) * WAKE_NOISE_ADAPTATION;
    if (!this.lastVoiceEnd || Date.now() < this.cooldownUntil) return;
    const sinceVoice = this.total - this.lastVoiceEnd;
    if (sinceVoice <= SAMPLE_RATE * WAKE_HANGOVER_SECONDS && voiced && (!this.lastScheduled || this.total - this.lastScheduled >= SAMPLE_RATE * WAKE_HOP_SECONDS)) {
      this.queue(this.total); this.lastScheduled = this.total;
    }
    if (!this.finalScheduled && sinceVoice >= SAMPLE_RATE * WAKE_FINAL_PAD_SECONDS) {
      this.queue(Math.min(this.total, this.lastVoiceEnd + Math.round(SAMPLE_RATE * WAKE_FINAL_PAD_SECONDS)));
      this.finalScheduled = true;
    }
  }

  private queue(end: number) {
    const base = this.total - this.audio.length;
    const window = this.audio.slice(Math.max(0, end - SAMPLE_RATE * WAKE_WINDOW_SECONDS - base), end - base);
    const job = { audio: downsample(window), end, length: window.length, epoch: this.epoch };
    if (this.busy) { if (this.pending) this.droppedWindows++; this.pending = job; }
    else this.dispatch(job);
  }

  private dispatch(job: Job) {
    if (Date.now() < this.retryAt) return;
    this.busy = true;
    this.worker!.postMessage({ type: 'audio', ...job }, [job.audio.buffer]);
  }

  private dispatchPending() {
    const next = this.pending; this.pending = undefined;
    if (next && next.epoch === this.epoch && Date.now() >= this.retryAt && Date.now() >= this.cooldownUntil) this.dispatch(next);
  }

  private detect(detector: WakeDiagnostic['detector'], text: string, start: number, inferenceMs: number, end: number, length: number) {
    const match = wakeMatch(text);
    if (!match || Date.now() < this.cooldownUntil) return;
    const absoluteStart = detector === 'webspeech'
      ? Math.max(0, this.voiceOnset - SAMPLE_RATE * WAKE_PREROLL_SECONDS)
      : end - length + Math.floor(Math.max(0, start - WAKE_START_MARGIN_SECONDS) * SAMPLE_RATE);
    const index = absoluteStart - (this.total - this.audio.length);
    if (index < 0 || index >= this.audio.length) return;
    const command = this.audio.slice(index);
    const diagnostic: WakeDiagnostic = { latencyMs: Math.round((this.total - this.voiceOnset) / SAMPLE_RATE * 1000), text: text.slice(match.start, match.end), score: match.score, detector, inferenceMs, droppedWindows: this.droppedWindows };
    this.cooldownUntil = Date.now() + WAKE_COOLDOWN_MS;
    this.reset();
    try {
      if (globalThis.localStorage?.getItem?.('marbles.debugWake') === 'true') console.debug('Wake detected', diagnostic);
    } catch { /* Optional diagnostic storage must never block activation. */ }
    this.wake(command, diagnostic);
  }

  private startWebSpeech() {
    if (!WAKE_WEB_SPEECH_ENABLED || this.suspended || typeof window === 'undefined') return;
    const browser = window as typeof window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) return;
    const recognition = new Constructor(); this.recognition = recognition;
    recognition.continuous = true; recognition.interimResults = true; recognition.lang = 'en-US';
    recognition.onresult = event => {
      if (this.suspended || this.recognition !== recognition) return;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const text = event.results[i][0]?.transcript ?? '';
        if (wakeMatch(text)) this.detect('webspeech', text, 0, 0, this.total, 0);
      }
    };
    recognition.onend = () => { if (!this.disposed && this.recognition === recognition) {
      try { recognition.start(); } catch { /* Browser may be shutting down. */ }
    } };
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'network') {
        recognition.onend = null; this.recognition = undefined;
        try { recognition.stop(); } catch { /* Already stopped. */ }
      }
    };
    try { recognition.start(); } catch { this.recognition = undefined; }
  }

  reset() {
    this.audio = new Float32Array(0); this.total = 0; this.lastVoiceEnd = this.voiceOnset = this.lastScheduled = 0;
    this.finalScheduled = false; this.pending = undefined; this.epoch++;
  }
  dispose() { this.disposed = true; this.rejectLoad?.(new Error('Wake startup cancelled.')); this.recognition?.stop(); this.recognition = undefined; this.worker?.terminate(); this.reset(); }
}
