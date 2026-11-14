import { describe, expect, it } from "vitest";
import { AimPoint, type AimParams } from "../aimPoint";

const P: AimParams = { aimTau: 0.15, aimFreezeDist: 0.09, aimFreezeRate: 0.25, aimHoldMs: 150 };
const FRAME = 1 / 15;
const OPEN = 0.15; // thumb-index gap of a hand that is pointing

// 21 landmarks with the index knuckle (5) and fingertip (8) placed.
const hand = (knuckle: [number, number], tip: [number, number]) => {
  const pts = new Array<number>(42).fill(0);
  pts[10] = knuckle[0];
  pts[11] = knuckle[1];
  pts[16] = tip[0];
  pts[17] = tip[1];
  return pts;
};

// Feed the same pose for n frames; return the last aim and the next time.
const settle = (a: AimPoint, pts: number[], dist: number, from: number, n: number, pinching = false) => {
  let out = { x: 0, y: 0 };
  let t = from;
  for (let i = 0; i < n; i++, t += FRAME) out = a.update(pts, dist, pinching, t, P);
  return { out, t };
};

describe("AimPoint", () => {
  it("is the fingertip for an open, still hand", () => {
    const a = new AimPoint();
    const { out } = settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 10);
    expect(out.x).toBeCloseTo(0.52, 6);
    expect(out.y).toBeCloseTo(0.4, 6);
  });

  it("follows the whole hand moving 1:1, with no lag", () => {
    const a = new AimPoint();
    let { t } = settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 5);
    for (let i = 1; i <= 10; i++, t += FRAME) {
      const d = i * 0.02;
      const out = a.update(hand([0.5 + d, 0.6 - d], [0.52 + d, 0.4 - d]), OPEN, false, t, P);
      expect(out.x).toBeCloseTo(0.52 + d, 6);
      expect(out.y).toBeCloseTo(0.4 - d, 6);
    }
  });

  it("does not dip when the fingertip drops into a pinch", () => {
    const a = new AimPoint();
    let { t } = settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 10);
    // The pinch closes over four frames: the tip drops 0.05, the gap shrinks.
    let out = { x: 0, y: 0 };
    for (let i = 1; i <= 4; i++, t += FRAME) {
      const dip = (0.05 * i) / 4;
      out = a.update(hand([0.5, 0.6], [0.52, 0.4 + dip]), OPEN - 0.03 * i, false, t, P);
    }
    expect(out.y).toBeCloseTo(0.4, 2);
    // Held closed: stays put for as long as the pinch lasts.
    out = settle(a, hand([0.5, 0.6], [0.52, 0.45]), 0.02, t, 20, true).out;
    expect(out.y).toBeCloseTo(0.4, 2);
    expect(a.frozen).toBe(true);
  });

  it("catches a slow close by the gap alone", () => {
    const a = new AimPoint();
    let { t } = settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 10);
    // Too slow to trip the rate, so the tip drifts a little before the gap
    // crosses the threshold, then freezes.
    let out = { x: 0, y: 0 };
    for (let i = 1; i <= 30; i++, t += FRAME) {
      const k = i / 30;
      out = a.update(hand([0.5, 0.6], [0.52, 0.4 + 0.05 * k]), OPEN - 0.13 * k, false, t, P);
    }
    expect(a.frozen).toBe(true);
    expect(out.y).toBeLessThan(0.43); // well short of the full 0.05 dip
  });

  it("stays frozen for the hold time after release, then eases to the finger", () => {
    const a = new AimPoint();
    let { t } = settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 10);
    t = settle(a, hand([0.5, 0.6], [0.52, 0.45]), 0.02, t, 5, true).t;
    // Reopened in a NEW finger pose.
    const open2 = hand([0.5, 0.6], [0.56, 0.42]);
    const first = a.update(open2, OPEN, false, t, P);
    expect(first.x).toBeCloseTo(0.52, 6); // still frozen: within the hold
    const { out } = settle(a, open2, OPEN, t + FRAME, 30);
    expect(out.x).toBeCloseTo(0.56, 3);
    expect(out.y).toBeCloseTo(0.42, 3);
  });

  it("does not jump when the fingers reopen to the same pose", () => {
    const a = new AimPoint();
    const open = hand([0.5, 0.6], [0.52, 0.4]);
    let { t } = settle(a, open, OPEN, 0, 10);
    t = settle(a, hand([0.5, 0.6], [0.52, 0.45]), 0.02, t, 5, true).t;
    for (let i = 0; i < 10; i++, t += FRAME) {
      const out = a.update(open, OPEN, false, t, P);
      expect(out.y).toBeCloseTo(0.4, 6);
    }
  });

  it("starts fresh after a reset or a long gap", () => {
    const a = new AimPoint();
    settle(a, hand([0.5, 0.6], [0.52, 0.4]), OPEN, 0, 5);
    const other = hand([0.2, 0.7], [0.1, 0.5]);
    const afterGap = a.update(other, OPEN, false, 60, P);
    expect(afterGap).toEqual({ x: 0.1, y: 0.5 });
    a.reset();
    expect(a.update(hand([0.3, 0.3], [0.35, 0.1]), OPEN, false, 60 + FRAME, P)).toEqual({ x: 0.35, y: 0.1 });
    expect(a.frozen).toBe(false);
  });

  it("is the raw fingertip when aimTau is 0", () => {
    const a = new AimPoint();
    const off = { ...P, aimTau: 0 };
    a.update(hand([0.5, 0.6], [0.52, 0.4]), OPEN, false, 0, off);
    expect(a.update(hand([0.5, 0.6], [0.52, 0.45]), 0.02, true, FRAME, off)).toEqual({ x: 0.52, y: 0.45 });
  });
});
