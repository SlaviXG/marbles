import { SAMPLE_RATE } from './audio';

// One inference at a time over overlapping four-second windows, with eight
// seconds of bounded local history to retain words spoken during inference.
export class WakeDetector {
  private worker?: Worker;
  private audio = new Float32Array(0);
  private total = 0;
  private sinceJob = 0;
  private busy = false;
  private epoch = 0;
  private disposed = false;
  private rejectLoad?: (error: Error) => void;
  constructor(private wake: (audio: Float32Array) => void, private error: (message: string) => void) {}

  load(progress: (percent: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.rejectLoad = reject;
      this.worker = new Worker(new URL('./wake.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onerror = () => { reject(new Error('Wake model could not start. Reload and try again.')); this.error('Wake model stopped. Reload and try again.'); };
      this.worker.onmessage = ({ data }) => {
        if (this.disposed) return;
        if (data.type === 'ready') { this.rejectLoad = undefined; resolve(); }
        else if (data.type === 'progress') progress(data.progress);
        else if (data.type === 'error') { reject(new Error(data.message)); this.error('Wake model failed. Check your connection and reload.'); }
        else if (data.type === 'result') {
          this.busy = false;
          if (data.epoch !== this.epoch || data.start == null) return;
          const absoluteStart = data.end - data.length + Math.floor(Math.max(0, data.start - 0.1) * SAMPLE_RATE);
          const start = absoluteStart - (this.total - this.audio.length);
          // If inference fell behind our buffer, ask the user to repeat rather
          // than dispatch a clipped command that has lost its wake boundary.
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
    if (this.disposed) return;
    const joined = new Float32Array(this.audio.length + audio.length);
    joined.set(this.audio); joined.set(audio, this.audio.length);
    this.audio = joined.slice(-SAMPLE_RATE * 8);
    this.total += audio.length; this.sinceJob += audio.length;
    if (this.busy || this.audio.length < SAMPLE_RATE || this.sinceJob < SAMPLE_RATE * 0.65) return;
    const recent = this.audio.slice(-SAMPLE_RATE);
    const rms = Math.sqrt(recent.reduce((sum, v) => sum + v * v, 0) / recent.length);
    if (rms < 0.004) return;
    this.busy = true; this.sinceJob = 0;
    const window = this.audio.slice(-SAMPLE_RATE * 4);
    // 24 kHz -> 16 kHz area averaging, matching Whisper's input sample rate.
    const samples = new Float32Array(Math.floor(window.length * 2 / 3));
    for (let i = 0; i < samples.length; i++) {
      const start = i * 1.5, end = start + 1.5;
      let sum = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += window[j] * (Math.min(end, j + 1) - Math.max(start, j));
      samples[i] = sum / 1.5;
    }
    this.worker!.postMessage({ type: 'audio', audio: samples, end: this.total, length: window.length, epoch: this.epoch }, [samples.buffer]);
  }

  reset() { this.audio = new Float32Array(0); this.sinceJob = 0; this.epoch++; }
  dispose() { this.disposed = true; this.rejectLoad?.(new Error('Wake startup cancelled.')); this.worker?.terminate(); this.reset(); }
}
