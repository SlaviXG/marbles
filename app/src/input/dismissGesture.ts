// Two ways to wave something away with a bare hand, recognised from the same
// cursor positions the hand already produces:
//
//   swipe  a fast, mostly sideways sweep that STARTS on a window: slap it away.
//   drop   the hand leaves downward at speed: everything on the stage closes.
//
// Both are deliberate movements. Resting a hand, reaching for a button or simply
// losing tracking does none of this, because each has to clear a speed and a
// distance threshold, and a pinch (a press or a drag) never counts.
export type HandSample = { x: number; y: number; present: boolean; pinching: boolean };
export type Dismissal = { type: 'swipe'; direction: -1 | 1; x: number; y: number } | { type: 'drop' };

export const DISMISS = {
  windowMs: 320, // a swipe is judged over at most this long
  swipePx: 280, // ...must travel this far sideways (or a fifth of the screen, if wider)
  swipeSpeed: 1500, // px/s, peak, sideways
  straightness: 2.2, // sideways travel must be this many times the vertical travel
  dropSpeed: 900, // px/s downward, just before the hand goes
  dropBelow: .62, // ...and it must leave from the lower part of the screen
  dropSettleMs: 450, // the hand must stay gone this long (a flicker is not a drop)
  minPresentMs: 500, // the hand must have been in view for a while first
  cooldownMs: 800,
};

export class DismissGesture {
  private samples: { t: number; x: number; y: number }[] = [];
  private presentSince = -1;
  private goneAt = -1;
  private exit: { vy: number; y: number; held: number } | null = null;
  private quietUntil = 0;

  step(now: number, hand: HandSample, viewport: { width: number; height: number }): Dismissal | null {
    if (!hand.present) {
      if (this.presentSince >= 0) {
        // The hand has just gone: remember how it left.
        const recent = this.samples.filter(sample => now - sample.t <= 260);
        const first = recent[0], last = recent[recent.length - 1];
        this.exit = first && last && last.t > first.t
          ? { vy: (last.y - first.y) / ((last.t - first.t) / 1000), y: last.y, held: this.goneAt < 0 ? last.t - this.presentSince : 0 } : null;
        this.goneAt = now; this.presentSince = -1; this.samples = [];
      }
      if (this.exit && now - this.goneAt >= DISMISS.dropSettleMs) {
        const { vy, y, held } = this.exit;
        this.exit = null;
        if (now >= this.quietUntil && held >= DISMISS.minPresentMs && vy >= DISMISS.dropSpeed && y >= viewport.height * DISMISS.dropBelow) {
          this.quietUntil = now + DISMISS.cooldownMs;
          return { type: 'drop' };
        }
      }
      return null;
    }
    if (this.presentSince < 0) { this.presentSince = now; this.exit = null; this.goneAt = -1; }
    if (hand.pinching) { this.samples = []; return null; }
    this.samples.push({ t: now, x: hand.x, y: hand.y });
    while (this.samples.length && now - this.samples[0].t > DISMISS.windowMs) this.samples.shift();
    if (now < this.quietUntil || this.samples.length < 4) return null;
    const start = this.samples[0];
    const dx = hand.x - start.x, dy = hand.y - start.y;
    if (Math.abs(dx) < Math.max(DISMISS.swipePx, viewport.width * .2) || Math.abs(dx) < Math.abs(dy) * DISMISS.straightness) return null;
    let peak = 0;
    for (let i = 1; i < this.samples.length; i++) {
      const a = this.samples[i - 1], b = this.samples[i];
      if (b.t > a.t) peak = Math.max(peak, Math.abs(b.x - a.x) / ((b.t - a.t) / 1000));
    }
    if (peak < DISMISS.swipeSpeed) return null;
    this.quietUntil = now + DISMISS.cooldownMs; this.samples = [];
    return { type: 'swipe', direction: dx > 0 ? 1 : -1, x: start.x, y: start.y };
  }
}
