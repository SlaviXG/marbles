export const SAMPLE_RATE = 24_000;

export function pcm16(audio: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(audio.length * 2);
  const view = new DataView(buffer);
  audio.forEach((value, i) => {
    const sample = Math.max(-1, Math.min(1, value));
    view.setInt16(i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  return buffer;
}

export type AudioTurn = { audio?: Float32Array; commit: boolean; speaking: boolean; level: number };

// Learn the room level for 400 ms, then require a sustained rise above it.
// Hysteresis avoids chattering between words; 750 ms pre-roll preserves onset.
export class AudioTurns {
  private preRoll = new Float32Array(0);
  private length = 0;
  private silence = 0;
  private attack = 0;
  private calibrated = 0;
  private noise = 0.003;

  push(audio: Float32Array): AudioTurn {
    const rms = Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length);
    const duration = audio.length / SAMPLE_RATE;
    const level = Math.min(1, Math.max(0, (rms - this.noise) * 12));
    if (!this.length) {
      const joined = new Float32Array(this.preRoll.length + audio.length);
      joined.set(this.preRoll);
      joined.set(audio, this.preRoll.length);
      this.preRoll = joined.slice(-SAMPLE_RATE * 0.75);
      if (this.calibrated < 0.4) {
        // Cap speech during calibration so talking immediately cannot establish
        // an impossibly high noise floor. Pre-roll retains this opening audio.
        this.noise += (Math.min(rms, 0.025) - this.noise) * 0.25;
        this.calibrated += duration;
        return { commit: false, speaking: false, level };
      }
      const threshold = Math.max(0.012, this.noise * 2.8);
      const above = rms > threshold;
      this.attack = above ? this.attack + duration : 0;
      if (!above) this.noise += (rms - this.noise) * Math.min(1, duration * 0.8);
      if (this.attack < 0.14) return { commit: false, speaking: false, level };
      audio = joined;
      this.preRoll = new Float32Array(0);
      this.attack = 0;
    }
    this.length += audio.length;
    // Lower release threshold keeps soft syllables inside a spoken phrase.
    const voiced = rms > Math.max(0.007, this.noise * 1.6);
    this.silence = voiced ? 0 : this.silence + audio.length;
    const commit = this.silence >= SAMPLE_RATE * 0.7 || this.length >= SAMPLE_RATE * 15;
    if (commit) this.flush();
    return { audio, commit, speaking: !commit, level };
  }

  flush(): boolean {
    const hasAudio = this.length >= SAMPLE_RATE * 0.1;
    this.length = this.silence = this.attack = 0;
    return hasAudio;
  }

  discard() { this.flush(); this.preRoll = new Float32Array(0); }
  begin(samples: number) { this.discard(); this.calibrated = 0.4; this.length = samples; }
}
