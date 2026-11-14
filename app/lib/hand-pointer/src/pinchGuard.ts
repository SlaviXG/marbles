// Stops a fast-moving hand from registering a pinch it did not make.
//
// When a hand sweeps quickly through the frame the camera blurs it, and the
// tracker's fingertip landmarks smear together. For a frame or two the thumb
// and index tips read as touching, which looks exactly like a quick pinch and
// fires a click nobody made. Vertical sweeps are the worst case, since the
// fingers blur along their own length.
//
// The guard blocks a pinch from STARTING while the hand is moving fast, and
// for a short moment after, while the tracker settles. It never ends a pinch
// that is already held, so a drag can be as fast as you like, and a click
// made with the hand at pointing speed is untouched: only the onset during
// ballistic travel is refused.
//
// Speed is read from the middle knuckle, not a fingertip. The knuckle is a
// large rigid feature that survives blur, and it does not move when the
// fingers close, so pinching itself never reads as speed.

// How long after fast motion a pinch still may not start (seconds). About two
// inference frames: the first sharp frame after a sweep is often still off.
export const PINCH_SETTLE = 0.12;
// Ignore absurd dt: the first sample, or a tab that was backgrounded.
const MAX_DT = 0.5;

export class PinchGuard {
  private lastX = 0;
  private lastY = 0;
  private lastT = NaN;
  private fastUntil = -Infinity;
  // Latest palm speed, in frame heights per second.
  speed = 0;

  // x, y: the palm's position in frame heights (x scaled by the frame's
  // aspect). maxSpeed: the fastest a hand may move and still start a pinch;
  // 0 or less turns the guard off.
  // Returns true while a pinch must not start.
  update(x: number, y: number, tSec: number, maxSpeed: number): boolean {
    const dt = tSec - this.lastT;
    if (dt > 0 && dt < MAX_DT) {
      this.speed = Math.hypot(x - this.lastX, y - this.lastY) / dt;
      if (maxSpeed > 0 && this.speed > maxSpeed) this.fastUntil = tSec + PINCH_SETTLE;
    } else {
      this.speed = 0;
    }
    this.lastX = x;
    this.lastY = y;
    this.lastT = tSec;
    return maxSpeed > 0 && tSec < this.fastUntil;
  }

  // The hand left the frame: its return is not a sweep.
  reset() {
    this.lastT = NaN;
    this.fastUntil = -Infinity;
    this.speed = 0;
  }
}

// The pinch decision with the guard applied: hysteresis as before, except
// that a pinch cannot begin while `blocked`. One already held is unaffected.
export function nextPinch(
  was: boolean,
  dist: number,
  on: number,
  off: number,
  blocked: boolean,
): boolean {
  return was ? dist < off : dist < on && !blocked;
}
