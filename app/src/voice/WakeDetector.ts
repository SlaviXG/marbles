import { SAMPLE_RATE } from './audio';

// One inference at a time over overlapping four-second windows, with eight
// seconds of bounded local history to retain words spoken during inference.
export class WakeDetector {
  private worker?: Worker;
  private audio = new Float32Array(0);
  private total = 0;
  private sinceJob = 0;
  private lastVoiceEnd = 0;
  private lastJobVoiceEnd = 0;
  private lastJobEnd = 0;
  private busy = false;
  private epoch = 0;
  private disposed = false;
  private loaded = false;
  private failures = 0;
  private retryAt = 0;
  private rejectLoad?: (error: Error) => void;
  constructor(private wake: (audio: Float32Array) => void, private error: (message: string) => void) {}

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
        if (data.type === 'ready') { this.loaded = true; this.rejectLoad = undefined; resolve(); }
        else if (data.type === 'progress') progress(data.progress);
        else if (data.type === 'error') {
          this.busy = false;
          const detail = typeof data.message === 'string' ? data.message.slice(0, 300) : 'Unknown local model error';
          if (!this.loaded || data.phase === 'load') {
            reject(new Error(`Wake model could not load: ${detail}`));
            return;
          }
          // A single noisy/short frame or failed alignment must not stop the
          // microphone. Back off and try a fresh window, but bound failures.
          console.warn('Local wake inference failed:', detail);
          this.failures++;
          this.retryAt = Date.now() + 1000;
          this.lastJobEnd = this.lastJobVoiceEnd = 0;
          if (this.failures >= 3) this.error(`Wake recognition failed repeatedly: ${detail}. Use Enable microphone to retry.`);
        }
        else if (data.type === 'result') {
          this.busy = false;
          this.failures = 0;
          if (data.epoch !== this.epoch || !Number.isFinite(data.start) || data.start < 0 || data.start > data.length / SAMPLE_RATE) {
            this.schedule(); return;
          }
          const absoluteStart = data.end - data.length + Math.floor(Math.max(0, data.start - 0.1) * SAMPLE_RATE);
          const start = absoluteStart - (this.total - this.audio.length);
          // Ignore a window that fell behind the buffer rather than dispatch
          // a clipped command that has lost its wake boundary.
          if (start < 0) return;
          const audio = this.audio.slice(start);
          this.reset();
          this.wake(audio);
        }
      };
      this.worker.postMessage({ type: 'load' });
    });
  }

  push(audio: Float32Array) {
    if (this.disposed || !this.loaded || !audio.length || !audio.every(Number.isFinite)) return;
    const joined = new Float32Array(this.audio.length + audio.length);
    joined.set(this.audio); joined.set(audio, this.audio.length);
    this.audio = joined.slice(-SAMPLE_RATE * 8);
    this.total += audio.length; this.sinceJob += audio.length;
    const rms = Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length);
    if (rms >= 0.0015) this.lastVoiceEnd = this.total;
    this.schedule();
  }

  private schedule() {
    if (this.disposed || !this.loaded || !this.lastVoiceEnd) return;
    if (this.busy || Date.now() < this.retryAt || this.audio.length < SAMPLE_RATE || this.sinceJob < SAMPLE_RATE * 0.65) return;
    // Finish decoding a word even when the speaker has already gone quiet.
    // Pin the window to speech, so a slow inference cannot replace it with
    // seconds of silence. One final padded window is enough until new speech.
    const end = Math.min(this.total, this.lastVoiceEnd + SAMPLE_RATE * 0.3);
    if (end <= this.lastJobEnd || (this.lastVoiceEnd <= this.lastJobVoiceEnd && end - this.lastJobEnd < SAMPLE_RATE * 0.2)) return;
    const bufferStart = this.total - this.audio.length;
    if (end <= bufferStart) return;
    const window = this.audio.slice(Math.max(0, end - SAMPLE_RATE * 4 - bufferStart), end - bufferStart);
    this.busy = true; this.sinceJob = 0;
    this.lastJobEnd = end; this.lastJobVoiceEnd = this.lastVoiceEnd;
    // 24 kHz -> 16 kHz area averaging, matching Whisper's input sample rate.
    const samples = new Float32Array(Math.floor(window.length * 2 / 3));
    for (let i = 0; i < samples.length; i++) {
      const start = i * 1.5, end = start + 1.5;
      let sum = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += window[j] * (Math.min(end, j + 1) - Math.max(start, j));
      samples[i] = sum / 1.5;
    }
    this.worker!.postMessage({ type: 'audio', audio: samples, end, length: window.length, epoch: this.epoch }, [samples.buffer]);
  }

  reset() {
    this.audio = new Float32Array(0); this.sinceJob = 0;
    this.lastVoiceEnd = this.lastJobVoiceEnd = this.lastJobEnd = 0;
    this.epoch++;
  }
  dispose() { this.disposed = true; this.rejectLoad?.(new Error('Wake startup cancelled.')); this.worker?.terminate(); this.reset(); }
}
