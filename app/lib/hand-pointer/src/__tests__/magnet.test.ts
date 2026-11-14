import { describe, it, expect } from "vitest";
import { magnetPull, drainOffset } from "../magnet";

// The pull weight decides how hard the hand cursor is drawn onto a node. Its
// boundary behavior is what the rest of the magnet relies on: zero at (and past)
// the capture edge so entering a field has no kick, one inside the lock radius so
// the dot sits exactly on center, and smoothly, monotonically increasing between.
describe("magnetPull (capture -> lock weight)", () => {
  const capture = 44;
  const lock = 12;

  it("is 0 at and beyond the capture edge (no kick on entry)", () => {
    expect(magnetPull(capture, capture, lock)).toBe(0);
    expect(magnetPull(capture + 20, capture, lock)).toBe(0);
  });

  it("is 1 at and within the lock radius (dot sits on center)", () => {
    expect(magnetPull(lock, capture, lock)).toBe(1);
    expect(magnetPull(0, capture, lock)).toBe(1);
  });

  it("rises smoothly and monotonically as the cursor nears the node", () => {
    let prev = -1;
    for (let d = capture; d >= lock; d -= 1) {
      const w = magnetPull(d, capture, lock);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(w).toBeGreaterThanOrEqual(prev); // never decreases as d shrinks
      prev = w;
    }
  });

  it("is smoothstep-shaped: gentle near both ends", () => {
    // Just inside the capture edge the pull is still weak, so acquisition is soft.
    expect(magnetPull(capture - 1, capture, lock)).toBeLessThan(0.05);
    // Near the lock radius it is nearly total, so the dot commits to the node.
    expect(magnetPull(lock + 1, capture, lock)).toBeGreaterThan(0.95);
  });
});

// Drains the pinch continuity offset with hand travel. Boundary behavior the
// drag depends on: direction preserved (the blend is straight), zero is a fixed
// point, and it never overshoots past zero (no reverse kick at the end).
describe("drainOffset (pinch-drag continuity)", () => {
  it("shrinks by the amount, preserving direction", () => {
    const d = drainOffset(30, 40, 10); // magnitude 50 -> 40
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(40, 6);
    expect(d.x / d.y).toBeCloseTo(30 / 40, 6);
  });

  it("never overshoots past zero", () => {
    expect(drainOffset(3, 4, 10)).toEqual({ x: 0, y: 0 });
    expect(drainOffset(3, 4, 5)).toEqual({ x: 0, y: 0 }); // exactly consumed
  });

  it("zero offset is a fixed point (no NaN from the normalize)", () => {
    expect(drainOffset(0, 0, 5)).toEqual({ x: 0, y: 0 });
  });
});
