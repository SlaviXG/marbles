import { describe, expect, it } from "vitest";
import {
  DepthZone,
  FACTOR_MAX,
  FACTOR_MIN,
  SizeTracker,
  depthFactor,
  LEARN_SECONDS,
  RATIO_MAX,
  RATIO_MIN,
  handScale,
  type Zone,
} from "../depthZone";

const FRAME = 1 / 15;
const HOME: Zone = { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85 };

// An upright right palm, in palm units (wrist at the origin, y down): wrist and
// the four knuckles, the only landmarks handScale reads.
const TEMPLATE: Record<number, [number, number]> = {
  0: [0, 0],
  5: [0.35, -0.95],
  9: [0.1, -1.0],
  13: [-0.12, -0.95],
  17: [-0.33, -0.85],
};
const FLAT = Math.hypot(0.35, 0.95); // the longest segment: wrist to index knuckle

// Place the palm at (cx, cy) with size s (frame heights), squashed by sx across
// and sy along (to imitate turning and tipping), and rotated by rad.
const palm = (cx: number, cy: number, s: number, sx = 1, sy = 1, rad = 0) => {
  const pts = new Array<number>(42).fill(0);
  for (const [i, [x, y]] of Object.entries(TEMPLATE)) {
    const px = x * sx * s;
    const py = y * sy * s;
    pts[+i * 2] = cx + px * Math.cos(rad) - py * Math.sin(rad);
    pts[+i * 2 + 1] = cy + px * Math.sin(rad) + py * Math.cos(rad);
  }
  return pts;
};

// Feed a still hand at one size for `seconds`; return the time after.
const hold = (z: DepthZone, nx: number, ny: number, size: number, from: number, seconds: number) => {
  let t = from;
  for (; t < from + seconds; t += FRAME) z.update(nx, ny, size, t);
  return t;
};

describe("handScale", () => {
  it("is the longest rigid palm segment, in frame heights", () => {
    expect(handScale(palm(0.5, 0.6, 0.1))).toBeCloseTo(0.1 * FLAT, 6);
  });

  it("does not change with position or in-plane rotation, and scales with size", () => {
    const base = handScale(palm(0.5, 0.6, 0.1));
    expect(handScale(palm(0.2, 0.3, 0.1, 1, 1, 1.2))).toBeCloseTo(base, 6);
    expect(handScale(palm(0.5, 0.6, 0.2))).toBeCloseTo(base * 2, 6);
  });

  it("barely changes when the hand turns sideways", () => {
    const base = handScale(palm(0.5, 0.6, 0.1));
    // Turned 60 degrees: everything across the hand at half width.
    expect(handScale(palm(0.5, 0.6, 0.1, 0.5, 1))).toBeGreaterThan(base * 0.9);
  });

  it("drops by at most a quarter when the hand tips 45 degrees toward the camera", () => {
    // The weak spot: tipping shortens every wrist-to-knuckle segment, and only
    // the knuckle line holds its length.
    const base = handScale(palm(0.5, 0.6, 0.1));
    expect(handScale(palm(0.5, 0.6, 0.1, 1, Math.SQRT1_2))).toBeGreaterThan(base * 0.74);
  });

  it("corrects for the frame's aspect", () => {
    const pts = palm(0.5, 0.6, 0.1);
    // The same hand on a 4:3 frame has its x coords squeezed by 3/4.
    const squeezed = pts.map((v, i) => (i % 2 === 0 ? 0.5 + (v - 0.5) * 0.75 : v));
    expect(handScale(squeezed, 4 / 3)).toBeCloseTo(handScale(pts), 6);
  });
});

describe("DepthZone", () => {
  it("keeps the configured zone until it has learned the reference size", () => {
    const z = new DepthZone(HOME);
    hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS * 0.8);
    expect(z.ratio).toBe(1);
    for (const k of ["x0", "y0", "x1", "y1"] as const) expect(z.zone[k]).toBeCloseTo(HOME[k], 9);
  });

  it("grows the zone as the hand comes closer, and shrinks it as the hand goes away", () => {
    const z = new DepthZone(HOME);
    let t = hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS + 0.2);
    expect(z.ratio).toBeCloseTo(1, 6);
    t = hold(z, 0.5, 0.5, 0.12, t, 8); // 20% bigger: closer
    expect(z.ratio).toBeCloseTo(1.2, 2);
    hold(z, 0.5, 0.5, 0.08, t, 8); // 20% smaller: further
    expect(z.ratio).toBeCloseTo(0.8, 2);
  });

  it("caps the scale both ways", () => {
    const z = new DepthZone(HOME);
    let t = hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS + 0.2);
    t = hold(z, 0.5, 0.5, 0.4, t, 10);
    expect(z.ratio).toBe(RATIO_MAX);
    hold(z, 0.5, 0.5, 0.01, t, 10);
    expect(z.ratio).toBe(RATIO_MIN);
  });

  it("never moves the cursor by itself: a still hand leaning in stays on the same spot", () => {
    const z = new DepthZone(HOME);
    // An off-centre hand, so the resize is visibly about the hand, not the zone.
    let t = hold(z, 0.3, 0.7, 0.1, 0, LEARN_SECONDS + 0.2);
    const before = z.map(0.3, 0.7);
    for (let i = 0; i < 90; i++, t += FRAME) {
      z.update(0.3, 0.7, 0.1 + i * 0.0005, t);
      const now = z.map(0.3, 0.7);
      expect(now.u).toBeCloseTo(before.u, 9);
      expect(now.v).toBeCloseTo(before.v, 9);
    }
    expect(z.ratio).toBeGreaterThan(1.1); // and the zone did change
  });

  it("moves the same distance on screen for the same arm movement at two distances", () => {
    // Near: the hand looks 1.25x bigger AND its movements look 1.25x bigger.
    const sweep = (size: number, reach: number) => {
      const z = new DepthZone(HOME);
      let t = hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS + 0.2); // reference at size 0.1
      t = hold(z, 0.5, 0.5, size, t, 10);
      const a = z.map(0.5, 0.5).u;
      z.update(0.5 + reach, 0.5, size, t);
      return z.map(0.5 + reach, 0.5).u - a;
    };
    const far = sweep(0.1, 0.1);
    const near = sweep(0.125, 0.125);
    expect(near).toBeCloseTo(far, 2);
  });

  it("eases back toward home only while the hand travels", () => {
    const z = new DepthZone(HOME);
    let t = hold(z, 0.2, 0.2, 0.1, 0, LEARN_SECONDS + 0.2);
    t = hold(z, 0.2, 0.2, 0.13, t, 20); // grew about a corner: now off-centre
    const centre = () => ((z.zone.x0 + z.zone.x1) / 2 - 0.5) ** 2 + ((z.zone.y0 + z.zone.y1) / 2 - 0.5) ** 2;
    const off = centre();
    expect(off).toBeGreaterThan(1e-4);
    const at = z.map(0.2, 0.2);
    t = hold(z, 0.2, 0.2, 0.13, t, 3); // resting: no creep, of the zone or the cursor
    expect(centre()).toBeCloseTo(off, 6);
    expect(z.map(0.2, 0.2).u).toBeCloseTo(at.u, 9);
    expect(z.map(0.2, 0.2).v).toBeCloseTo(at.v, 9);
    for (let i = 0; i < 200; i++, t += FRAME) {
      const k = Math.sin(i / 8);
      z.update(0.5 + 0.25 * k, 0.5 + 0.2 * k, 0.13, t);
    }
    expect(centre()).toBeLessThan(off * 0.05);
  });

  it("keeps the scale steady when the size reading is noisy", () => {
    const z = new DepthZone(HOME);
    let t = hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS + 0.2);
    let lo = Infinity;
    let hi = -Infinity;
    let seed = 7;
    for (let i = 0; i < 300; i++, t += FRAME) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const noise = (seed / 2147483648 - 0.5) * 0.02; // +-10% of the size
      z.update(0.5, 0.5, 0.1 + noise, t);
      lo = Math.min(lo, z.ratio);
      hi = Math.max(hi, z.ratio);
    }
    expect(hi - lo).toBeLessThan(0.08);
  });

  it("uses a fixed reference when one is given", () => {
    const z = new DepthZone(HOME);
    hold(z, 0.5, 0.5, 0.12, 0, 0.5);
    let t = 0.5;
    for (let i = 0; i < 60; i++, t += FRAME) z.update(0.5, 0.5, 0.12, t, 0.1);
    expect(z.ratio).toBeCloseTo(1.2, 6);
  });

  it("goes home when released, keeping the reference; reset forgets it", () => {
    const z = new DepthZone(HOME);
    let t = hold(z, 0.5, 0.5, 0.1, 0, LEARN_SECONDS + 0.2);
    t = hold(z, 0.5, 0.5, 0.13, t, 6);
    z.release();
    expect(z.zone).toEqual(HOME);
    expect(z.ref).toBeCloseTo(0.1, 6);
    z.update(0.5, 0.5, 0.13, t + 1); // reseeded at the new size: compensated at once
    expect(z.ratio).toBeCloseTo(1.3, 6);
    z.reset();
    expect(Number.isNaN(z.ref)).toBe(true);
    expect(z.zone).toEqual(HOME);
  });

  it("maps a hand outside the zone to the screen edge", () => {
    const z = new DepthZone(HOME);
    expect(z.map(0.05, 0.95)).toEqual({ u: 0, v: 1 });
  });
});

describe("depthFactor", () => {
  it("scales thresholds in proportion to apparent hand size", () => {
    // A hand twice as close looks twice as big, and so do its finger gaps.
    expect(depthFactor(0.2, 0.1)).toBeCloseTo(2, 9);
    expect(depthFactor(0.075, 0.1)).toBeCloseTo(0.75, 9);
  });

  it("makes the same physical pinch read the same at any distance", () => {
    // A 2 cm gap on a hand 9 cm across, seen at two distances.
    const at = (zoom: number) => {
      const size = 0.1 * zoom;
      const gap = (2 / 9) * size;
      return gap / depthFactor(size, 0.1);
    };
    expect(at(0.8)).toBeCloseTo(at(1.25), 9);
  });

  it("is capped, and 1 until there is a reference", () => {
    expect(depthFactor(1, 0.1)).toBe(FACTOR_MAX);
    expect(depthFactor(0.001, 0.1)).toBe(FACTOR_MIN);
    expect(depthFactor(0.2, NaN)).toBe(1);
    expect(depthFactor(NaN, 0.1)).toBe(1);
  });
});

describe("SizeTracker", () => {
  it("seeds on the first reading, then follows slowly", () => {
    const s = new SizeTracker();
    expect(s.update(0.1, 0)).toBe(0.1);
    let t = FRAME;
    s.update(0.2, t);
    expect(s.value).toBeLessThan(0.11);
    for (; t < 10; t += FRAME) s.update(0.2, t);
    expect(s.value).toBeCloseTo(0.2, 3);
  });

  it("starts again after a reset or a long gap", () => {
    const s = new SizeTracker();
    s.update(0.1, 0);
    expect(s.update(0.3, 5)).toBe(0.3);
    s.reset();
    expect(s.update(0.05, 5.1)).toBe(0.05);
  });
});
