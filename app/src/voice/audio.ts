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

// Client VAD commits phrases on pauses. Keep pre-roll for quiet consonants and
// cap turns at 15 seconds; OpenAI sends transcript deltas before each commit.
export class AudioTurns {
  private preRoll = new Float32Array(0);
  private length = 0;
  private silence = 0;

  push(audio: Float32Array): { audio?: Float32Array; commit: boolean } {
    const voiced = Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length) >= 0.01;
    if (!this.length) {
      const joined = new Float32Array(this.preRoll.length + audio.length);
      joined.set(this.preRoll);
      joined.set(audio, this.preRoll.length);
      if (!voiced) { this.preRoll = joined.slice(-SAMPLE_RATE / 4); return { commit: false }; }
      audio = joined;
      this.preRoll = new Float32Array(0);
    }
    this.length += audio.length;
    this.silence = voiced ? 0 : this.silence + audio.length;
    const commit = this.silence >= SAMPLE_RATE * 0.7 || this.length >= SAMPLE_RATE * 15;
    if (commit) this.flush();
    return { audio, commit };
  }

  flush(): boolean {
    const hasAudio = this.length >= SAMPLE_RATE * 0.1;
    this.length = this.silence = 0;
    return hasAudio;
  }
}
