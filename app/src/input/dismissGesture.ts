// Two ways to wave something away with a bare hand:
//
//   swipe  a quick, mostly sideways sweep: slap a window off the screen.
//   drop   the hand leaves downward at speed: everything on the stage closes.
//
// A slap is fast, and fast is exactly when hand tracking is at its worst: the
// hand blurs, detections go missing for a few frames, and a pinch can flicker.
// So recognition is built to survive that:
//   - it measures the whole sweep between any two recent positions, not a
//     frame-to-frame peak, so a gap in the middle costs nothing;
//   - positions are kept across short dropouts instead of being thrown away;
//   - a hand that sweeps right out of view still counts (it was last seen near
//     the edge it was heading for);
//   - only a pinch that is actually held cancels it.
// Resting, pointing and ordinary reaching stay below the distance and speed
// needed, and nothing counts while something is being dragged.
export type HandSample = { x: number; y: number; present: boolean; pinching: boolean };
export type Dismissal =
  | { type: 'swipe'; direction: -1 | 1; path: { x: number; y: number }[] }
  | { type: 'drop' };

export const DISMISS = {
  windowMs: 600, // a swipe may take this long from start to finish
  swipeShare: .16, // ...and must cross this share of the view's width
  swipeMinPx: 150,
  swipeSpeed: .8, // view widths per second, averaged over the sweep
  straightness: 1.4, // sideways travel must be this many times the vertical travel
  minSweepMs: 50,
  edgeShare: .2, // "near an edge": within this share of the width
  pinchHoldMs: 160, // a pinch held this long is a drag, not a flicker
  gapMs: 450, // positions survive a tracking dropout this long
  dropSpeed: 900, // px/s downward, just before the hand goes
  dropBelow: .62, // ...and it must leave from the lower part of the view
  dropSettleMs: 450, // the hand must stay gone this long (a flicker is not a drop)
  minPresentMs: 500, // the hand must have been in view for a while first
  cooldownMs: 700,
};

type Point = { t: number; x: number; y: number };

export class DismissGesture {
  private samples: Point[] = [];
  private presentSince = -1;
  private goneAt = -1;
  private exit: { vy: number; y: number; held: number } | null = null;
  private pinchSince = -1;
  private quietUntil = 0;
  private exitChecked = true;

  private sweep(now: number, end: Point, width: number): Dismissal | null {
    const need = Math.max(DISMISS.swipeMinPx, width * DISMISS.swipeShare);
    for (const start of this.samples) {
      const dt = end.t - start.t;
      if (dt < DISMISS.minSweepMs || now - start.t > DISMISS.windowMs) continue;
      const dx = end.x - start.x, dy = end.y - start.y;
      if (Math.abs(dx) < need || Math.abs(dx) < Math.abs(dy) * DISMISS.straightness) continue;
      if (Math.abs(dx) / (dt / 1000) < width * DISMISS.swipeSpeed) continue;
      const path = this.samples.filter(point => point.t >= start.t && point.t <= end.t).map(({ x, y }) => ({ x, y }));
      this.quietUntil = now + DISMISS.cooldownMs; this.samples = [];
      return { type: 'swipe', direction: dx > 0 ? 1 : -1, path };
    }
    return null;
  }

  step(now: number, hand: HandSample, viewport: { width: number; height: number }): Dismissal | null {
    if (!hand.present) {
      if (this.presentSince >= 0) {
        const recent = this.samples.filter(sample => now - sample.t <= 260);
        const first = recent[0], last = recent[recent.length - 1];
        this.exit = first && last && last.t > first.t ? { vy: (last.y - first.y) / ((last.t - first.t) / 1000), y: last.y, held: last.t - this.presentSince } : null;
        this.goneAt = now; this.presentSince = -1; this.exitChecked = false;
      }
      if (now >= this.quietUntil && !this.exitChecked && this.samples.length) {
        // Swept clean out of view: last seen close to the side it was heading for.
        this.exitChecked = true;
        const last = this.samples[this.samples.length - 1];
        const side = last.x > viewport.width * (1 - DISMISS.edgeShare) ? 1 : last.x < viewport.width * DISMISS.edgeShare ? -1 : 0;
        if (side) {
          const swipe = this.sweep(now, { ...last, x: side > 0 ? Math.max(last.x, viewport.width * .98) : Math.min(last.x, viewport.width * .02), t: Math.max(last.t + DISMISS.minSweepMs, now) }, viewport.width);
          if (swipe && swipe.type === 'swipe' && swipe.direction === side) { this.exit = null; return swipe; }
        }
      }
      if (now - this.goneAt > DISMISS.gapMs) this.samples = [];
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
    if (this.presentSince < 0) {
      // Back after a short dropout: the same movement continues.
      this.presentSince = this.goneAt >= 0 && now - this.goneAt <= DISMISS.gapMs && this.samples.length ? this.samples[0].t : now;
      this.exit = null; this.goneAt = -1;
    }
    if (hand.pinching) {
      if (this.pinchSince < 0) this.pinchSince = now;
      if (now - this.pinchSince >= DISMISS.pinchHoldMs) { this.samples = []; return null; }
    } else this.pinchSince = -1;
    const point = { t: now, x: hand.x, y: hand.y };
    // A pinch in progress might be the start of a drag, so nothing is judged
    // during it; the positions are kept in case it was only a flicker.
    const result = now >= this.quietUntil && !hand.pinching ? this.sweep(now, point, viewport.width) : null;
    if (result) return result;
    this.samples.push(point);
    while (this.samples.length && now - this.samples[0].t > DISMISS.windowMs) this.samples.shift();
    return null;
  }
}
