// Dropping your hands clears the stage: the hand leaves downward, at speed,
// from the lower part of the view, and stays gone.
//
// An open palm can also swish one aimed window away. It must settle on that
// window first, then make a fast, straight sideways sweep. An index pointing,
// a drag, a slow reach and a pass over a window never arm this gesture.
//
// Even so the bar is high. The hand must have been steadily in view, must be
// travelling fast and mostly downward as it goes, and must not come straight
// back. Lowering your hands to rest, at ordinary speed, does nothing.
export type HandSample = { x: number; y: number; present: boolean; pinching: boolean; open?: boolean; target?: string | null };
export type Dismissal = { type: 'drop' } | { type: 'swipe'; target: string; direction: -1 | 1 };

// Pointing is not a slap: at least three fingers must be extended.
export function openPalm(pts: number[]): boolean {
  if (pts.length < 42 || pts.some(value => !Number.isFinite(value))) return false;
  const distance = (i: number) => Math.hypot(pts[i * 2] - pts[0], pts[i * 2 + 1] - pts[1]);
  return [8, 12, 16, 20].filter(tip => distance(tip) > distance(tip - 2) * 1.12).length >= 3;
}

export const SWISH = { armMs: 220, restPx: 32, windowMs: 420, cooldownMs: 1100, pinchReleaseMs: 300,
  travelPx: 160, travelShare: .12, speed: 850, speedShare: .8, straightness: 1.8, directness: .86 };

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
  private candidate: string | null = null;
  private candidateAt = 0;
  private rest: Point = { t: 0, x: 0, y: 0 };
  private swipeTarget: string | null = null;
  private swipeUntil = 0;
  private swipePoints: Point[] = [];
  private lastOpen = -Infinity;
  private lastPresent = -Infinity;
  get armedTarget() { return this.swipeTarget; }

  private swish(now: number, hand: HandSample, width: number): Dismissal | null {
    const reset = () => { this.candidate = this.swipeTarget = null; this.swipePoints = []; };
    if (hand.present) this.lastPresent = now;
    if (hand.pinching) { reset(); this.quietUntil = Math.max(this.quietUntil, now + SWISH.pinchReleaseMs); return null; }
    if (hand.open && hand.present) this.lastOpen = now;
    if (!hand.present) { if (now - this.lastPresent > 140) reset(); return null; }
    if (now - this.lastOpen > 120 || now < this.quietUntil) { reset(); return null; }
    if (this.swipeTarget && now > this.swipeUntil) reset();
    if (!this.swipeTarget) {
      if (!hand.open || !hand.target) { reset(); return null; }
      if (this.candidate !== hand.target || Math.hypot(hand.x - this.rest.x, hand.y - this.rest.y) > SWISH.restPx) {
        this.candidate = hand.target; this.candidateAt = now; this.rest = { t: now, x: hand.x, y: hand.y };
      }
      if (now - this.candidateAt < SWISH.armMs) return null;
      this.swipeTarget = this.candidate;
      this.swipePoints = [{ t: now, x: hand.x, y: hand.y }];
      this.swipeUntil = now + SWISH.windowMs;
    }
    const first = this.swipePoints[0];
    if (hand.target === this.swipeTarget && Math.hypot(hand.x - first.x, hand.y - first.y) <= SWISH.restPx) {
      this.swipePoints = [{ t: now, x: hand.x, y: hand.y }]; this.swipeUntil = now + SWISH.windowMs;
      return null;
    }
    const last = this.swipePoints[this.swipePoints.length - 1];
    if (Math.hypot(hand.x - last.x, hand.y - last.y) < 2 || now - last.t < 18) return null;
    this.swipePoints.push({ t: now, x: hand.x, y: hand.y });
    const dx = hand.x - first.x, dy = hand.y - first.y, dt = now - first.t;
    const travel = this.swipePoints.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - this.swipePoints[i].x, p.y - this.swipePoints[i].y), 0);
    if (this.swipePoints.length < 3 || dt < 70 || dt > SWISH.windowMs
      || Math.abs(dx) < Math.max(SWISH.travelPx, width * SWISH.travelShare)
      || Math.abs(dx) < Math.abs(dy) * SWISH.straightness
      || Math.abs(dx) / (dt / 1000) < Math.max(SWISH.speed, width * SWISH.speedShare)
      || Math.hypot(dx, dy) / travel < SWISH.directness) return null;
    const event: Dismissal = { type: 'swipe', target: this.swipeTarget!, direction: dx > 0 ? 1 : -1 };
    reset(); this.quietUntil = now + SWISH.cooldownMs;
    return event;
  }

  step(now: number, hand: HandSample, viewport: { width: number; height: number }): Dismissal | null {
    const swipe = this.swish(now, hand, viewport.width);
    if (swipe) return swipe;
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
