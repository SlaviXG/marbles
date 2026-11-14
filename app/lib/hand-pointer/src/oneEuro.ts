// One Euro filter (Casiez, Roussel, Vogel): an adaptive low-pass for noisy
// interactive signals. The cutoff frequency rises with speed, so a still hand is
// smoothed hard (no jitter) while a fast hand is barely smoothed (no lag). Two
// knobs: minCutoff (smoothing at rest) and beta (how fast it loosens with speed).
// Cheaper and lower-latency than a spring for the tracked point itself; the
// spring is reserved for the cursor's visual settle (see HandCursor).
class LowPass {
  private s: number | undefined;
  filter(x: number, alpha: number): number {
    this.s = this.s === undefined ? x : alpha * x + (1 - alpha) * this.s;
    return this.s;
  }
}

export class OneEuro {
  private xf = new LowPass();
  private dxf = new LowPass();
  private lastT: number | null = null;
  private lastX: number | null = null;

  constructor(
    public minCutoff = 1.0,
    public beta = 0.02,
    public dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  // x: raw sample, t: timestamp in seconds.
  filter(x: number, t: number): number {
    const dt = this.lastT != null && t > this.lastT ? t - this.lastT : 1 / 60;
    this.lastT = t;
    const dx = this.lastX === null ? 0 : (x - this.lastX) / dt;
    this.lastX = x;
    const edx = this.dxf.filter(dx, this.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xf.filter(x, this.alpha(cutoff, dt));
  }
}
