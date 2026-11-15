// Dropping your hands clears the stage: the hand leaves downward, at speed,
// from the lower part of the view, and stays gone.
//
// This is the only thing a bare, open hand can close. Waving a hand across a
// window used to close it too, and did so by accident far too often: an open
// hand moving quickly is simply what pointing looks like. Throwing a window
// away now needs a grip first (pinch it, then fling it; see useDragMove).
//
// Even so the bar is high. The hand must have been steadily in view, must be
// travelling fast and mostly downward as it goes, and must not come straight
// back. Lowering your hands to rest, at ordinary speed, does nothing.
export type HandSample = { x: number; y: number; present: boolean; pinching: boolean };
export type Dismissal = { type: 'drop' };

export const DISMISS = {
  dropSpeed: 1300, // px/s downward, just before the hand goes
  steepness: 1.6, // downward travel must be this many times the sideways travel
  dropBelow: .68, // it must leave from the lower part of the view
  dropSettleMs: 600, // and stay gone this long (a flicker is not a drop)
  minPresentMs: 900, // after being in view for a while
  cooldownMs: 1200,
};

type Point = { t: number; x: number; y: number };

export class DismissGesture {
  private samples: Point[] = [];
  private presentSince = -1;
  private goneAt = -1;
  private exit: { vx: number; vy: number; y: number; held: number } | null = null;
  private quietUntil = 0;

  step(now: number, hand: HandSample, viewport: { width: number; height: number }): Dismissal | null {
    if (!hand.present) {
      if (this.presentSince >= 0) {
        // The hand has just gone: remember how it left.
        const recent = this.samples.filter(sample => now - sample.t <= 260);
        const first = recent[0], last = recent[recent.length - 1];
        const seconds = first && last ? (last.t - first.t) / 1000 : 0;
        this.exit = seconds > 0 ? { vx: (last.x - first.x) / seconds, vy: (last.y - first.y) / seconds, y: last.y, held: last.t - this.presentSince } : null;
        this.goneAt = now; this.presentSince = -1; this.samples = [];
      }
      if (this.exit && now - this.goneAt >= DISMISS.dropSettleMs) {
        const { vx, vy, y, held } = this.exit;
        this.exit = null;
        if (now >= this.quietUntil && held >= DISMISS.minPresentMs && vy >= DISMISS.dropSpeed && vy >= Math.abs(vx) * DISMISS.steepness && y >= viewport.height * DISMISS.dropBelow) {
          this.quietUntil = now + DISMISS.cooldownMs;
          return { type: 'drop' };
        }
      }
      return null;
    }
    if (this.presentSince < 0) { this.presentSince = now; this.exit = null; this.goneAt = -1; }
    // A pinch is a grip on something; letting go of it is not a drop.
    if (hand.pinching) { this.samples = []; this.presentSince = now; return null; }
    this.samples.push({ t: now, x: hand.x, y: hand.y });
    while (this.samples.length && now - this.samples[0].t > 400) this.samples.shift();
    return null;
  }
}
