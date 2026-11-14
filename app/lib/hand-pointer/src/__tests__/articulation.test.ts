import { describe, expect, it } from "vitest";
import { ArticulationTracker, normalizeShape } from "../articulation";

// A small stand-in hand: 5 points, enough to have a centroid and a scale.
const shape = (spread: number): number[] => [0, 0, spread, 0, 0, spread, -spread, 0, 0, -spread];

const translated = (pts: number[], dx: number, dy: number) =>
  pts.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));

const scaled = (pts: number[], k: number) => pts.map((v) => v * k);

// Move ONE point: a finger bending. Note that growing the whole shape would not
// do, because that is a uniform scale, which is exactly what normalizeShape
// removes (a hand moving toward the camera is not a hand articulating).
const bend = (pts: number[], amount: number) => {
  const out = pts.slice();
  out[2] += amount;
  return out;
};

describe("normalizeShape", () => {
  it("is invariant to translation", () => {
    const a = normalizeShape(shape(1));
    const b = normalizeShape(translated(shape(1), 5, -3));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 10));
  });

  it("is invariant to scale, so moving toward the camera is not articulation", () => {
    const a = normalizeShape(shape(1));
    const b = normalizeShape(scaled(shape(1), 4));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 10));
  });

  it("survives a degenerate all-points-coincident hand", () => {
    expect(() => normalizeShape([1, 1, 1, 1, 1, 1])).not.toThrow();
  });
});

describe("ArticulationTracker", () => {
  it("reports nothing on the first sample", () => {
    expect(new ArticulationTracker().update(shape(1), 0)).toBe(0);
  });

  it("stays at zero for a hand that only translates", () => {
    const t = new ArticulationTracker();
    t.update(shape(1), 0);
    for (let i = 1; i < 10; i++) t.update(translated(shape(1), i * 0.1, 0), i * 0.066);
    expect(t.value).toBeCloseTo(0, 6);
  });

  it("rises for a hand that changes shape in place", () => {
    const t = new ArticulationTracker();
    t.update(shape(1), 0);
    for (let i = 1; i < 10; i++) t.update(bend(shape(1), i * 0.05), i * 0.066);
    expect(t.value).toBeGreaterThan(0.05);
  });

  it("is rate-normalised, so a dropped frame does not spike it", () => {
    // Same total shape change, delivered in one slow step vs two quick ones.
    const slow = new ArticulationTracker();
    slow.update(shape(1), 0);
    slow.update(bend(shape(1), 0.2), 0.2);

    const fast = new ArticulationTracker();
    fast.update(shape(1), 0);
    fast.update(bend(shape(1), 0.1), 0.1);
    fast.update(bend(shape(1), 0.2), 0.2);

    // Within the same order of magnitude: without the /dt these would differ by
    // the frame-interval ratio, and a stalled pipeline would look like intent.
    expect(slow.value).toBeGreaterThan(0);
    expect(Math.abs(slow.value - fast.value)).toBeLessThan(slow.value);
  });

  it("forgets the pose on reset, so a returning hand does not spike", () => {
    const t = new ArticulationTracker();
    t.update(shape(1), 0);
    t.reset();
    expect(t.update(shape(3), 0.066)).toBe(0);
  });
});
