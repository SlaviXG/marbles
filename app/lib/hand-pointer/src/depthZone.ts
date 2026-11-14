// Distance compensation: the same arm movement should move the cursor the same
// distance whether the hand is 40 cm or 80 cm from the camera.
//
// A camera divides everything by distance (similar triangles):
//
//     image movement  = focal length x hand movement / distance
//     image hand size = focal length x hand size     / distance
//
// so  hand movement is proportional to  image movement / image hand size.
//
// The focal length and the real hand size both cancel. Measuring movement in
// hand sizes instead of frame fractions makes the cursor independent of
// distance, with nothing to calibrate.
//
// It is applied by resizing the active zone (the part of the camera frame that
// maps to the whole screen) in proportion to the hand's apparent size: a hand
// twice as close looks twice as big, so it gets a zone twice as big and the
// same movement covers the same share of it. Three rules keep that from ever
// moving the cursor by itself:
//   - The zone is resized about the point the hand is aiming at, so that point
//     stays at the same place on screen. Leaning in or out, holding the hand
//     still, leaves the cursor where it is.
//   - Resizing about the hand pulls the zone off-centre over time, which would
//     leave part of the screen out of reach. It is eased back toward its home
//     position only while the hand travels, in proportion to the travel, so a
//     resting cursor never creeps.
//   - The apparent size is smoothed over seconds (real distance changes
//     slowly; the size reading is noisy) and the zone's scale is capped, so a
//     far, noisy hand cannot become a twitchy cursor.

export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// Rigid palm segments: wrist to each knuckle, and across the knuckles. None of
// them bend with the fingers. Every one of them shortens when the hand rotates
// (turning sideways shortens the knuckle line, tipping toward the camera
// shortens the wrist-to-knuckle lines), but a rotation rarely shortens them
// all at once, so the longest is a fair measure of the hand's size.
const SEGMENTS: [number, number][] = [
  [0, 5],
  [0, 9],
  [0, 13],
  [0, 17],
  [5, 17],
];

// pts: the 21 landmarks, flat [x0,y0,...] in normalized frame coords.
// aspect: frame width / height, so x and y are measured in the same unit.
// Returns the hand's apparent size in frame heights.
export function handScale(pts: number[], aspect = 1): number {
  let best = 0;
  for (const [a, b] of SEGMENTS) {
    const d = Math.hypot((pts[b * 2] - pts[a * 2]) * aspect, pts[b * 2 + 1] - pts[a * 2 + 1]);
    if (d > best) best = d;
  }
  return best;
}

// How much a hand-measured threshold must grow for a hand of this apparent
// size, against the reference size. Similar triangles again: a thumb-index gap
// of so many centimetres, or a palm moving so many centimetres per second,
// looks bigger in the image in exact proportion to the hand's apparent size
// (both are divided by the same distance). So every threshold expressed in
// frame units must scale PROPORTIONALLY with apparent size, which is
// INVERSELY with distance: a hand twice as close needs thresholds twice as
// big. Equivalently, divide the measurement by this factor and keep the
// threshold fixed. 1 until a reference has been learned.
export const FACTOR_MIN = 0.5;
export const FACTOR_MAX = 2;

export function depthFactor(size: number, ref: number): number {
  if (!(size > 1e-6) || !(ref > 1e-6)) return 1;
  return clamp(size / ref, FACTOR_MIN, FACTOR_MAX);
}

// The smoothed apparent size of one hand, for scaling its own thresholds.
export class SizeTracker {
  value = NaN;
  private lastT = NaN;

  update(size: number, tSec: number): number {
    const dt = tSec - this.lastT;
    if (Number.isFinite(size) && size > 1e-6) {
      if (!Number.isFinite(this.value) || !(dt > 0 && dt < MAX_DT)) this.value = size;
      else this.value += (size - this.value) * (1 - Math.exp(-dt / DEPTH_TAU));
    }
    this.lastT = tSec;
    return this.value;
  }

  reset() {
    this.value = NaN;
    this.lastT = NaN;
  }
}

// Seconds. How slowly the size reading follows the hand. Leaning in or out
// takes a second or more; the per-frame size reading wobbles by several
// percent, so it is smoothed well past one inference interval.
export const DEPTH_TAU = 1.5;
// Seconds of tracking used to learn the reference size: the distance at which
// the zone keeps its configured size. Learned per session, so the cursor feels
// exactly as configured wherever the user first sits, and only CHANGES of
// distance after that are compensated.
export const LEARN_SECONDS = 1;
// Limits on how far the zone may be scaled. 0.6 is a hand at about 1.7x the
// reference distance, 1.4 one at about 0.7x. Past these the cursor stops
// compensating rather than amplifying the noise of a far, small hand. 1.4
// times the default zone (0.7 of the frame) still fits inside the frame.
export const RATIO_MIN = 0.6;
export const RATIO_MAX = 1.4;
// How much of each frame's hand travel is used to ease the zone back toward
// its home position (fraction, in frame units). While it does, the cursor
// moves up to this much faster or slower than the hand.
export const RECENTER = 0.15;
// Ignore absurd dt: the first sample, or a tab that was backgrounded.
const MAX_DT = 0.5;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export class DepthZone {
  // The zone in use, in mirrored normalized frame coords (as toScreen sees).
  zone: Zone;
  // Current scale of the zone against its configured size.
  ratio = 1;
  // Smoothed apparent hand size (frame heights), and the learned reference.
  scale = NaN;
  ref = NaN;
  private home: Zone;
  private learned = 0;
  private lastT = NaN;
  private lastX = NaN;
  private lastY = NaN;

  constructor(home: Zone) {
    this.home = { ...home };
    this.zone = { ...home };
  }

  // The configured zone changed (params saved elsewhere): start from it.
  setHome(home: Zone) {
    this.home = { ...home };
    this.zone = { ...home };
    this.ratio = 1;
  }

  // nx, ny: where the driving hand aims, mirrored, filtered, normalized.
  // size: handScale() of the driving hand this frame.
  // fixedRef: a reference size to use instead of learning one (0 = learn).
  update(nx: number, ny: number, size: number, tSec: number, fixedRef = 0): void {
    const dt = tSec - this.lastT;
    const good = dt > 0 && dt < MAX_DT;

    if (Number.isFinite(size) && size > 1e-6) {
      if (!Number.isFinite(this.scale) || !good) this.scale = size;
      else this.scale += (size - this.scale) * (1 - Math.exp(-dt / DEPTH_TAU));
    }
    if (fixedRef > 0) {
      this.ref = fixedRef;
    } else if (!Number.isFinite(this.ref) && Number.isFinite(this.scale)) {
      if (good) this.learned += dt;
      if (this.learned >= LEARN_SECONDS) this.ref = this.scale;
    }
    const ratio =
      Number.isFinite(this.ref) && Number.isFinite(this.scale)
        ? clamp(this.scale / this.ref, RATIO_MIN, RATIO_MAX)
        : 1;

    const z = this.zone;
    const cx = (z.x0 + z.x1) / 2;
    const cy = (z.y0 + z.y1) / 2;
    const hw = (z.x1 - z.x0) / 2;
    const hh = (z.y1 - z.y0) / 2;
    const homeHw = (this.home.x1 - this.home.x0) / 2;
    const homeHh = (this.home.y1 - this.home.y0) / 2;

    // Resize about the point the cursor is at. A hand outside the zone has its
    // cursor pinned at the screen edge, so the anchor is the zone's edge there.
    const ax = cx + clamp((nx - cx) / hw, -1, 1) * hw;
    const ay = cy + clamp((ny - cy) / hh, -1, 1) * hh;
    const nhw = homeHw * ratio;
    const nhh = homeHh * ratio;
    let ncx = ax - (ax - cx) * (nhw / hw);
    let ncy = ay - (ay - cy) * (nhh / hh);

    // Ease back toward home, paid for by hand travel only.
    if (good && Number.isFinite(this.lastX)) {
      const travel = Math.hypot(nx - this.lastX, ny - this.lastY);
      const hx = (this.home.x0 + this.home.x1) / 2 - ncx;
      const hy = (this.home.y0 + this.home.y1) / 2 - ncy;
      const off = Math.hypot(hx, hy);
      if (off > 0 && travel > 0) {
        const step = Math.min(off, travel * RECENTER) / off;
        ncx += hx * step;
        ncy += hy * step;
      }
    }

    this.zone = { x0: ncx - nhw, y0: ncy - nhh, x1: ncx + nhw, y1: ncy + nhh };
    this.ratio = ratio;
    this.lastT = tSec;
    this.lastX = nx;
    this.lastY = ny;
  }

  // Normalized point -> 0..1 across the screen, through the current zone.
  map(nx: number, ny: number): { u: number; v: number } {
    const z = this.zone;
    return {
      u: clamp((nx - z.x0) / (z.x1 - z.x0), 0, 1),
      v: clamp((ny - z.y0) / (z.y1 - z.y0), 0, 1),
    };
  }

  // The cursor went away: the zone goes home (nothing on screen to move) and
  // the size reading starts again. The learned reference is kept.
  release() {
    this.zone = { ...this.home };
    this.ratio = 1;
    this.scale = NaN;
    this.lastT = NaN;
    this.lastX = NaN;
    this.lastY = NaN;
  }

  // The camera session ended: forget the reference too.
  reset() {
    this.release();
    this.ref = NaN;
    this.learned = 0;
  }
}
