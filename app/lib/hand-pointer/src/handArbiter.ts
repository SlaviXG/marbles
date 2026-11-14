// Which hand drives the cursor when both are in frame.
//
// The user should not have to say. Whichever hand they are pointing with is
// the one that moves; the other hangs in the air, roughly still. So the cursor
// follows the hand that is moving while the other one is at rest, and stays
// with it until the roles clearly reverse.
//
// "Clearly" matters more than "quickly". A wrong switch hands the cursor to a
// hand the user is not pointing with, which is far worse than a late one, so
// every rule here leans toward staying put:
//   - the other hand must be moving AND the driving one still by comparison
//     (two hands moving alike, or two still hands, change nothing);
//   - that must be seen on consecutive frames and add up to enough evidence,
//     so neither one noisy frame nor a long run of marginal ones does it;
//   - a driving hand that drops out for a frame or two keeps the cursor;
//   - straight after a switch the bar is higher, so the cursor does not flip
//     back;
//   - nothing switches while the driving hand is pinching, which is a click,
//     drag or zoom in progress.
//
// Everything here takes time and positions as arguments (no DOM, no clock),
// so it can be unit-tested and replayed.

import { drainOffset } from "./magnet";

type Side = "L" | "R";

// ---------------------------------------------------------------------------
// The signal: how far a hand is from where it recently was.
//
// A lagged copy of the position follows the hand with time constant
// MOTION_TAU. Motion is the distance between the hand and that copy. A hand
// moving at a steady speed runs ahead of its copy by about speed * MOTION_TAU;
// a hand that stops is caught up within a few tenths of a second; a hand that
// only jitters stays on top of its copy and reads near zero.
//
// Why a lagged position rather than a window of samples: results arrive about
// 70-80 ms apart and irregularly. A 0.15 s window holds two or three of them,
// so its reading depends on where the frame boundaries happen to fall, and it
// empties (reads zero) whenever one frame is late. The exponential lag uses
// the real dt of every step, so the reading barely depends on frame timing
// and a late frame costs nothing.
//
// Motion is measured in PALM LENGTHS (wrist to middle knuckle), not in frame
// heights. The same gesture covers fewer frame heights the further the hand
// is from the camera; dividing by the palm's size in the image cancels that,
// and it cancels most of the tracker's jitter the same way, since jitter also
// scales with how large the hand appears.
export const MOTION_TAU = 0.2; // s, lag of the reference position
// Restart after a gap this long (s): the tab was backgrounded or the hand was
// gone, and where it is now says nothing about how it has been moving.
export const MAX_GAP = 0.5;
// The palm length is itself noisy and changes only as the hand moves toward
// or away from the camera, so it is smoothed over this long (s).
const PALM_TAU = 0.5;
// A step and the one before it count as "there and back" when they nearly
// cancel (their sum is under this fraction of the larger one)...
const REVERSAL_CANCEL = 0.5;
// ...and both are real jumps, not jitter (over this many palm lengths).
const REVERSAL_MIN = 0.15;
// The hand's own recent motion, for its change of speed (see onset): a slow
// average of `value`, over about this long (s).
export const BASE_TAU = 1;

const WRIST = 0;
const MIDDLE_MCP = 9;

// The palm's length in the image: wrist to middle knuckle, with x scaled by
// the frame's aspect so it is in frame heights (the same vector fingersUp in
// palm.ts measures). The unit MotionTracker divides by.
export function palmSpan(pts: number[], aspect = 1): number {
  const dx = (pts[MIDDLE_MCP * 2] - pts[WRIST * 2]) * aspect;
  const dy = pts[MIDDLE_MCP * 2 + 1] - pts[WRIST * 2 + 1];
  return Math.hypot(dx, dy);
}

export class MotionTracker {
  // Distance from the lagged position, in palm lengths.
  value = 0;
  // This frame looks like a there-and-back glitch: the tracker put the hand
  // somewhere else for one frame and then back. See update().
  reversal = false;
  // How much faster the hand is moving now than it has been lately: `value`
  // above its own slow average, never negative. A hand that speeds up reads
  // high here at once; one moving at a steady pace reads near zero, however
  // fast. This is what lets a hand that starts moving take the cursor from
  // one that is still drifting along (see HandArbiter).
  onset = 0;
  private base = 0;

  private lastT = NaN;
  private lagX = 0;
  private lagY = 0;
  // The lag as it stood before the previous frame moved it, to undo a glitch.
  private lagWasX = 0;
  private lagWasY = 0;
  private prevX = 0;
  private prevY = 0;
  private stepX = 0;
  private stepY = 0;
  private palmS = NaN; // smoothed palm length

  // x, y: the hand's position in frame heights (x scaled by the frame's
  //   aspect, so both axes agree).
  // palm: the palm's length in the same units (palmSpan). A zero or
  //   non-finite one is ignored and the last good length is kept.
  update(x: number, y: number, palm: number, tSec: number): number {
    const dt = tSec - this.lastT;
    const palmOk = Number.isFinite(palm) && palm > 1e-6;
    this.lastT = tSec;
    if (!(dt > 0 && dt <= MAX_GAP)) {
      // First sample, time went backwards, or a long gap: start again from
      // here. Arriving is not a move.
      this.lagX = this.lagWasX = this.prevX = x;
      this.lagY = this.lagWasY = this.prevY = y;
      this.stepX = this.stepY = 0;
      this.palmS = palmOk ? palm : NaN;
      this.value = 0;
      this.reversal = false;
      this.onset = 0;
      this.base = 0;
      return 0;
    }
    if (palmOk) {
      this.palmS = Number.isNaN(this.palmS)
        ? palm
        : this.palmS + (palm - this.palmS) * (1 - Math.exp(-dt / PALM_TAU));
    }
    const unit = this.palmS; // NaN until a usable palm has been seen

    // Glitch check: this step undoes the previous one. A real hand cannot go
    // a sixth of a palm one way and straight back within two frames; a
    // tracker that briefly locks onto something else does exactly that.
    const sx = x - this.prevX;
    const sy = y - this.prevY;
    const step = Math.hypot(sx, sy);
    const prevStep = Math.hypot(this.stepX, this.stepY);
    this.reversal =
      Math.hypot(sx + this.stepX, sy + this.stepY) < REVERSAL_CANCEL * Math.max(step, prevStep) &&
      Math.min(step, prevStep) > REVERSAL_MIN * unit;
    if (this.reversal) {
      // The previous frame dragged the lag toward the bogus position. Left
      // like that, the hand (now back where it was) would read as moving for
      // several more frames while the lag returned, which for a large jump is
      // enough to take the cursor. Put the lag back where it stood before.
      this.lagX = this.lagWasX;
      this.lagY = this.lagWasY;
    }

    // Measured BEFORE the lag moves, so the reading includes this step whole.
    this.value = unit > 0 ? Math.hypot(x - this.lagX, y - this.lagY) / unit : 0;

    // Change of speed: this reading against the hand's own recent average.
    this.onset = Math.max(0, this.value - this.base);
    this.base += (this.value - this.base) * (1 - Math.exp(-dt / BASE_TAU));

    this.lagWasX = this.lagX;
    this.lagWasY = this.lagY;
    const a = 1 - Math.exp(-dt / MOTION_TAU);
    this.lagX += (x - this.lagX) * a;
    this.lagY += (y - this.lagY) * a;
    this.stepX = sx;
    this.stepY = sy;
    this.prevX = x;
    this.prevY = y;
    return this.value;
  }

  // The hand left the frame: a return is not a move.
  reset() {
    this.lastT = NaN;
    this.palmS = NaN;
    this.stepX = this.stepY = 0;
    this.value = 0;
    this.reversal = false;
    this.onset = 0;
    this.base = 0;
  }
}

// ---------------------------------------------------------------------------
// The decision.
//
// All motion values are in palm lengths (see MotionTracker).

// The least motion that counts as pointing. A deliberate move reads 0.3 or
// more; a hand held still reads a few hundredths.
export const MOVE = 0.12;
// How much a hand's change of speed (MotionTracker.onset) adds to its motion
// when the two hands are compared. With it, a hand that starts moving beats a
// driving hand that is still drifting along at a steady pace, even one moving
// as fast: what the user does to take the cursor is speed the other hand UP.
// Both hands get the same treatment, so two hands speeding up together still
// change nothing. It never helps a hand over the MOVE bar: that is judged on
// motion alone, so jitter on a still hand cannot use it.
export const ONSET_WEIGHT = 1;
// The driving hand is "still by comparison" while its motion is below this
// fraction of the other hand's. A hand held in the air sways, and the further
// the other hand moves the less that sway should count; without the ratio a
// slightly unsteady resting hand blocks the handover indefinitely.
export const REST_RATIO = 0.6;
// Evidence is the time the condition has held, weighted by how far past the
// bar the other hand is: a move that clears the bar by MOVE counts 1 s per
// second, a larger one faster up to GAIN_MAX, a marginal one slower. So a
// clear move switches in two frames and a marginal one has to persist.
export const GAIN_MAX = 2;
export const EVIDENCE = 0.08; // s of gain-weighted evidence needed to switch
// Evidence drains at this rate (per second) while the condition fails, rather
// than being thrown away: one bad frame in the middle of a move costs a frame
// or two, not the whole wait.
export const LEAK = 1;
// The condition must also hold on this many consecutive frames. Evidence
// alone could be satisfied by a single frame after a long dt; no single frame
// may move the cursor to another hand.
export const MIN_FRAMES = 2;
// For this long after a switch (s) the bar is doubled, so the hand that just
// lost the cursor (often still settling) does not take it straight back.
export const REFRACTORY = 0.6;
// A driving hand missing from the frame keeps the cursor for this long (s)
// before the other hand takes over. Single missed detections are common (a
// pinched hand hides its own landmarks, the pose gate flickers, the tracker
// swaps its left/right labels for a frame), and none of them is the user
// changing hands.
export const DRIVER_GRACE = 0.25;
// dt between calls is clamped to this (s), so a stall does not turn one frame
// into a second's worth of evidence or leak.
const MAX_DT = 0.2;

export class HandArbiter {
  // The hand currently driving, or null before any hand has been seen.
  driver: Side | null = null;
  // What the arbiter is doing about a handover, for the debug overlay:
  //   ""              nothing to decide (one hand or none, or just started)
  //   "other still"   the other hand is not moving enough
  //   "driver moving" the other hand is moving, but so is the driving one
  //   "pinch"         the driving hand is pinching
  //   "glitch"        the other hand's move looked like a tracking glitch
  //   "evidence"      the condition holds and evidence is building
  //   "grace"         the driving hand is missing and is being waited for
  //   "switched"      the cursor changed hands on this frame
  why = "";

  private e = 0; // evidence so far, seconds
  private n = 0; // consecutive frames the condition has held
  private boostUntil = -Infinity; // the bar is doubled until then
  private driverSeen = NaN; // when the driving hand was last in frame
  private lastT = NaN;
  private lastPreferred: Side | null = null;

  // Progress toward a handover, 0..1, for the debug overlay.
  get evidence(): number {
    return Math.min(1, Math.max(0, this.e / EVIDENCE));
  }

  // motion: MotionTracker.value for each hand that is in frame and usable
  //   (omit a hand that is not).
  // reversal: MotionTracker.reversal for the same hands.
  // locked: the driving hand is pinching; never switch under it.
  // onset: MotionTracker.onset for the same hands (optional; omitted counts
  //   as no change of speed, which is the plain motion comparison).
  // preferred: the hand the user nominated. Used when there is nothing to go
  //   on (both hands appear together), and obeyed at once when it changes.
  // Returns the hand that should drive this frame, or null if none is in
  // frame. The hand returned may itself be MISSING from `motion`: that is the
  // grace case, and the caller should hold the cursor rather than move it.
  update(
    motion: Partial<Record<Side, number>>,
    reversal: Partial<Record<Side, boolean>>,
    locked: boolean,
    preferred: Side,
    tSec: number,
    onset: Partial<Record<Side, number>> = {},
  ): Side | null {
    const hasL = motion.L !== undefined;
    const hasR = motion.R !== undefined;
    const changed = this.lastPreferred !== null && this.lastPreferred !== preferred;
    this.why = "";
    this.lastPreferred = preferred;
    // The first call has no dt and so contributes no evidence.
    let dt = tSec - this.lastT;
    dt = dt > 0 ? Math.min(dt, MAX_DT) : 0;
    this.lastT = tSec;

    if (!hasL && !hasR) {
      // Remember the driver through a dropout so a missed frame does not
      // hand the cursor over when both hands come back.
      this.fail(dt);
      return null;
    }

    if (hasL !== hasR) {
      const only: Side = hasL ? "L" : "R";
      this.fail(dt);
      if (this.driver === null || this.driver === only) {
        // One hand, and it is (or becomes) the driver.
        this.driver = only;
        this.driverSeen = tSec;
        return only;
      }
      // Only the hand that is NOT driving is in frame. Under a pinch the
      // driver is kept however long it is missing: the caller ends the pinch
      // once the hand has really gone, and that lifts the lock.
      if (locked || tSec - this.driverSeen < DRIVER_GRACE) {
        this.why = "grace";
        return this.driver;
      }
      this.switchTo(only, tSec);
      return only;
    }

    // Both hands in frame.
    if (this.driver === null || (changed && !locked)) {
      this.driver = preferred;
      this.driverSeen = tSec;
      this.e = 0;
      this.n = 0;
      return this.driver;
    }
    this.driverSeen = tSec;
    const other: Side = this.driver === "L" ? "R" : "L";
    const theirs = motion[other]!;
    const bar = MOVE * (tSec < this.boostUntil ? 2 : 1);
    // What the other hand has to beat: the bar, on its motion alone; and the
    // driving hand, with each hand scored as its motion plus its change of
    // speed, so the driver must be still BY COMPARISON. A driver drifting at
    // a steady pace scores its motion; a hand that has just sped up scores
    // more than its motion, and takes the cursor even from a moving driver.
    const score = (h: Side) => motion[h]! + ONSET_WEIGHT * (onset[h] ?? 0);
    const ex = Math.min(theirs - bar, score(other) - score(this.driver) / REST_RATIO);
    if (locked) {
      this.e = 0;
      this.n = 0;
      this.why = "pinch";
    } else if (reversal[other]) {
      this.e = 0;
      this.n = 0;
      this.why = "glitch";
    } else if (ex > 0) {
      this.e += Math.min(GAIN_MAX, ex / MOVE) * dt;
      // A repeated timestamp is the same frame seen twice, not a second one.
      if (dt > 0) this.n++;
      this.why = "evidence";
    } else {
      this.fail(dt);
      this.why = theirs > bar ? "driver moving" : "other still";
    }
    if (this.e >= EVIDENCE && this.n >= MIN_FRAMES) this.switchTo(other, tSec);
    return this.driver;
  }

  // A frame on which the condition does not hold: the evidence leaks and the
  // run of consecutive frames ends.
  private fail(dt: number) {
    this.e = Math.max(0, this.e - LEAK * dt);
    this.n = 0;
  }

  private switchTo(hand: Side, tSec: number) {
    this.driver = hand;
    this.driverSeen = tSec;
    this.e = 0;
    this.n = 0;
    this.boostUntil = tSec + REFRACTORY;
    this.why = "switched";
  }

  reset() {
    this.driver = null;
    this.why = "";
    this.e = 0;
    this.n = 0;
    this.boostUntil = -Infinity;
    this.driverSeen = NaN;
    this.lastT = NaN;
    this.lastPreferred = null;
  }
}

// ---------------------------------------------------------------------------
// Stops a hand that takes the cursor over from pressing with it at once.
//
// Pinch state belongs to the physical hand, and a resting hand often sits
// with thumb and finger close together. If such a hand takes the cursor, its
// "pinch" would become a press on the very frame of the handover: a click or
// the start of a drag nobody made. So a handover latches the press off until
// the new hand's thumb-index gap has been seen at or beyond the release
// threshold, that is, until the hand has visibly been open. A pinch made
// after that is a real one.
export class PinchLatch {
  // While true the driving hand's pinch is not passed on as a press.
  on = false;

  // handover: a different hand took the cursor on this frame.
  // pinching: the driving hand's own pinch state (per physical hand).
  // gap: its thumb tip to index tip distance; pinchOff: the release threshold.
  // Returns whether the cursor should be pressing.
  update(handover: boolean, pinching: boolean, gap: number, pinchOff: number): boolean {
    if (handover) this.on = true;
    // >= rather than >: the pinch hysteresis releases at gap >= pinchOff, so
    // this is exactly "the hand is not holding a pinch any more".
    if (this.on && gap >= pinchOff) this.on = false;
    return pinching && !this.on;
  }

  reset() {
    this.on = false;
  }
}

// Keeps the cursor where it is when a different hand takes it over.
//
// The two hands are in different places, so mapping the new one straight to
// the screen would teleport the cursor. Instead the new hand picks the cursor
// up from where it stands: the gap between the cursor and the hand's own
// mapped position is kept as an offset and added to every later position.
//
// A permanent offset would leave part of the screen out of reach, so it
// drains as the hand travels: each px the hand moves removes `recycle` px of
// offset. A still hand keeps the cursor exactly in place; a moving one blends
// back to its true position without the cursor ever jumping.
export class HandoffOffset {
  x = 0;
  y = 0;
  private last: { x: number; y: number } | null = null;

  // A new hand takes over a cursor standing at (cursorX, cursorY).
  begin(cursorX: number, cursorY: number, handX: number, handY: number) {
    this.x = cursorX - handX;
    this.y = cursorY - handY;
    this.last = { x: handX, y: handY };
  }

  // The driving hand's mapped position -> where the cursor should aim.
  apply(handX: number, handY: number, recycle: number): { x: number; y: number } {
    if (this.last && (this.x !== 0 || this.y !== 0)) {
      const moved = Math.hypot(handX - this.last.x, handY - this.last.y);
      const o = drainOffset(this.x, this.y, moved * recycle);
      this.x = o.x;
      this.y = o.y;
    }
    this.last = { x: handX, y: handY };
    return { x: handX + this.x, y: handY + this.y };
  }

  // The cursor went away: the next hand to appear starts at its own position.
  clear() {
    this.x = 0;
    this.y = 0;
    this.last = null;
  }
}
