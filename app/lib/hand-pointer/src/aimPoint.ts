// Where a hand is pointing, in a form that does not move when it pinches.
//
// The obvious cursor point is the index fingertip. But closing a pinch pulls
// the fingertip down toward the thumb, so the cursor dips during the very
// gesture that is meant to click: the press starts where the user aimed, the
// cursor slides while the pinch is held, and the release lands somewhere
// else. A click on a small target is lost, or turns into a drag.
//
// The index knuckle (where the finger meets the palm) barely moves in a
// pinch. So the aim point is built from it:
//
//     aim = knuckle + V        V = fingertip - knuckle, remembered
//
// While the hand is open, V follows the real finger (with a little easing), so
// aim IS the fingertip and pointing feels the same as before. While the
// fingers are closing or closed, V is frozen at its last open value, so aim
// keeps following the hand through the knuckle but ignores the finger curling
// in. When the fingers reopen, V eases back to the real finger; it has usually
// barely changed, so nothing jumps.
//
// A wrong freeze is cheap, which is why this is safe to trigger early: the
// cursor still tracks the hand, it only stops listening to the finger alone.

const KNUCKLE = 5; // index MCP
const TIP = 8; // index fingertip
// Ignore absurd dt: the first sample, or a tab that was backgrounded.
const MAX_DT = 0.5;

export interface AimParams {
  // Seconds. How quickly V follows the real finger while the hand is open.
  // 0 turns the whole thing off: aim is the raw fingertip.
  aimTau: number;
  // Freeze V while the thumb-index gap is below this (normalized units). Set
  // just above the pinch release threshold, so V is already frozen before the
  // fingers get close enough to move the fingertip much.
  aimFreezeDist: number;
  // Freeze V while the gap is closing faster than this (normalized units per
  // second): the start of a pinch, caught before the gap is small.
  aimFreezeRate: number;
  // Keep V frozen this long after the last reason to freeze (ms), so one
  // frame of noise does not release it mid-pinch.
  aimHoldMs: number;
}

export class AimPoint {
  private vx = 0;
  private vy = 0;
  private has = false;
  private lastT = NaN;
  private lastDist = NaN;
  private holdUntil = -Infinity;
  // Whether V is frozen right now, for the debug overlay.
  frozen = false;

  // pts: the 21 landmarks, flat [x0,y0,...] in normalized frame coords.
  // dist: thumb tip to index tip distance, the same value the pinch uses.
  // Returns the aim point in the same normalized coords.
  update(
    pts: number[],
    dist: number,
    pinching: boolean,
    tSec: number,
    p: AimParams,
  ): { x: number; y: number } {
    const kx = pts[KNUCKLE * 2];
    const ky = pts[KNUCKLE * 2 + 1];
    const tx = pts[TIP * 2];
    const ty = pts[TIP * 2 + 1];
    if (!(p.aimTau > 0)) {
      this.frozen = false;
      return { x: tx, y: ty };
    }
    const rawX = tx - kx;
    const rawY = ty - ky;
    const dt = tSec - this.lastT;
    const goodDt = dt > 0 && dt < MAX_DT;
    if (!this.has || !goodDt) {
      // First sight of this hand (or after a gap): take the finger as it is.
      this.vx = rawX;
      this.vy = rawY;
      this.has = true;
      this.holdUntil = -Infinity;
    }
    const closing = goodDt && Number.isFinite(this.lastDist) ? (this.lastDist - dist) / dt : 0;
    if (pinching || dist < p.aimFreezeDist || closing > p.aimFreezeRate) {
      this.holdUntil = tSec + p.aimHoldMs / 1000;
    }
    this.frozen = tSec < this.holdUntil;
    if (!this.frozen && goodDt) {
      const a = 1 - Math.exp(-dt / p.aimTau);
      this.vx += (rawX - this.vx) * a;
      this.vy += (rawY - this.vy) * a;
    }
    this.lastT = tSec;
    this.lastDist = dist;
    return { x: kx + this.vx, y: ky + this.vy };
  }

  // The hand left the frame: forget its finger.
  reset() {
    this.has = false;
    this.lastT = NaN;
    this.lastDist = NaN;
    this.holdUntil = -Infinity;
    this.frozen = false;
  }
}
