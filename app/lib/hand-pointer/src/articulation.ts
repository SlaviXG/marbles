// How much a hand is CHANGING SHAPE, as opposed to moving through space.
//
// The arbiter needs to know which hand is being used deliberately. Raw movement
// cannot tell: a hand travelling across the frame in a fixed pointing pose moves
// a lot and articulates none, while a hand forming a pinch articulates a lot and
// barely moves. Gesturing is articulation, so that is what to measure.
//
// Method: remove translation (subtract the centroid) and scale (divide by the
// mean radius), then difference against the previous frame. That is a Procrustes
// shape distance without the rotation step, which is deliberate: wrist rotation
// is intentional gesturing and should count, unlike depth and position.
//
// Rate normalisation is not optional. The frame pump drops frames under
// backpressure, and tracking two hands made that worse, so a per-frame delta
// would spike whenever inference stalled and the arbiter would swap hands
// every time the machine got busy. Dividing by dt measures shape velocity.

// Landmarks (x,y pairs) -> translation and scale invariant copy.
export function normalizeShape(pts: number[]): number[] {
  const n = pts.length / 2;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  cx /= n;
  cy /= n;
  let scale = 0;
  for (let i = 0; i < n; i++) {
    scale += Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy);
  }
  scale /= n;
  const out = new Array<number>(pts.length);
  if (scale < 1e-6) return out.fill(0);
  for (let i = 0; i < n; i++) {
    out[i * 2] = (pts[i * 2] - cx) / scale;
    out[i * 2 + 1] = (pts[i * 2 + 1] - cy) / scale;
  }
  return out;
}

// Smoothing for the articulation signal. Long enough to ride out a single noisy
// inference result, short enough to react within a deliberate gesture.
const TAU = 0.3;
// Ignore absurd dt: a tab that was backgrounded, or the first sample.
const MAX_DT = 0.5;

export class ArticulationTracker {
  private prev: number[] | null = null;
  private lastT = NaN;
  // Smoothed shape velocity, in normalised units per second.
  value = 0;

  // pts: raw landmarks for this frame. tSec: timestamp in seconds.
  update(pts: number[], tSec: number): number {
    const cur = normalizeShape(pts);
    const dt = tSec - this.lastT;
    if (this.prev && dt > 0 && dt < MAX_DT) {
      let sum = 0;
      const n = cur.length / 2;
      for (let i = 0; i < n; i++) {
        sum += Math.hypot(cur[i * 2] - this.prev[i * 2], cur[i * 2 + 1] - this.prev[i * 2 + 1]);
      }
      const raw = sum / n / dt;
      const a = 1 - Math.exp(-dt / TAU);
      this.value += (raw - this.value) * a;
    }
    this.prev = cur;
    this.lastT = tSec;
    return this.value;
  }

  // The hand left the frame: forget the pose, keep no stale velocity.
  reset() {
    this.prev = null;
    this.lastT = NaN;
    this.value = 0;
  }
}
