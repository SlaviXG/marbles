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

export type AudioTurn = { audio?: Float32Array; commit: boolean; speaking: boolean; level: number;
  /** The turn was steady sound (music, a video, a fan), not someone talking. */ background?: boolean };

// How long unbroken sound may run before it is judged to be background.
// Speech breathes: within a few seconds it always dips back toward the room
// level between words and phrases. Music and video soundtracks do not.
export const BACKGROUND_SECONDS = 3.5;
// The quietest 20 ms of a steady sound is at least this share of its average level.
const STEADINESS = 0.3;
const BLOCK = 480; // 20 ms at 24 kHz: short enough to see the gaps between words

// Learn the room level for 400 ms, then require a sustained rise above it.
// Hysteresis avoids chattering between words; 750 ms pre-roll preserves onset.
export class AudioTurns {
  private preRoll = new Float32Array(0);
  private length = 0;
  private silence = 0;
  private attack = 0;
  private calibrated = 0;
  private noise = 0.003;
  private quietest = Infinity; // the quietest 20 ms heard in the current turn
  private energy = 0; // summed rms of the turn, for its average level
  private chunks = 0;
  private heard = 0; // samples of the turn itself, without the pre-roll

  push(audio: Float32Array): AudioTurn {
    const rms = Math.sqrt(audio.reduce((sum, v) => sum + v * v, 0) / audio.length);
    const duration = audio.length / SAMPLE_RATE;
    const fresh = audio; // this chunk alone: the pre-roll joined below is the quiet before the sound
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
    for (let start = 0; start + BLOCK <= fresh.length; start += BLOCK) {
      let sum = 0;
      for (let i = start; i < start + BLOCK; i++) sum += fresh[i] * fresh[i];
      this.quietest = Math.min(this.quietest, Math.sqrt(sum / BLOCK));
    }
    this.energy += rms; this.chunks++; this.heard += fresh.length;
    // Sound that has gone this long without once dropping near the room level
    // is not a person speaking. Learn it as the new room level, so it stops
    // opening turns, and tell the caller to throw the turn away. Anyone talking
    // over it still stands out, because speech is louder than its bed.
    // Steady means two things at once: it never fell back toward the room level,
    // and its quietest moment is a large share of its average. Speech fails the
    // second test even in a noisy room, because consonants and gaps cut deep.
    const average = this.energy / this.chunks;
    if (this.heard >= SAMPLE_RATE * BACKGROUND_SECONDS && this.quietest > Math.max(0.012, this.noise * 2.2, average * STEADINESS)) {
      this.noise = Math.min(0.2, (this.quietest + average) / 2);
      this.flush();
      return { audio, commit: true, speaking: false, level, background: true };
    }
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
    this.quietest = Infinity; this.energy = 0; this.chunks = 0; this.heard = 0;
    return hasAudio;
  }

  discard() { this.flush(); this.preRoll = new Float32Array(0); }
  begin(samples: number) { this.discard(); this.calibrated = 0.4; this.length = samples; }
}
