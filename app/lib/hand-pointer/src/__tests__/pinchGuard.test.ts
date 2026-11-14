import { describe, expect, it } from "vitest";
import { PINCH_SETTLE, PinchGuard, nextPinch } from "../pinchGuard";

const FRAME = 1 / 15;
const MAX = 1.5;

describe("PinchGuard", () => {
  it("does not block a still or slowly moving hand", () => {
    const g = new PinchGuard();
    for (let i = 0; i < 20; i++) {
      // 0.5 frame heights per second: ordinary pointing.
      expect(g.update(0.5, 0.2 + 0.5 * i * FRAME, i * FRAME, MAX)).toBe(false);
    }
  });

  it("blocks during a fast sweep and for the settle time after it", () => {
    const g = new PinchGuard();
    g.update(0.5, 0.1, 0, MAX);
    // 3 frame heights per second, straight down.
    expect(g.update(0.5, 0.1 + 3 * FRAME, FRAME, MAX)).toBe(true);
    expect(g.update(0.5, 0.1 + 6 * FRAME, 2 * FRAME, MAX)).toBe(true);
    // The hand stops. Still blocked until the settle time has passed.
    const stop = 2 * FRAME;
    expect(g.update(0.5, 0.1 + 6 * FRAME, stop + PINCH_SETTLE * 0.5, MAX)).toBe(true);
    expect(g.update(0.5, 0.1 + 6 * FRAME, stop + PINCH_SETTLE * 1.1, MAX)).toBe(false);
  });

  it("does not treat a hand entering the frame, or a long gap, as a sweep", () => {
    const g = new PinchGuard();
    expect(g.update(0.9, 0.9, 0, MAX)).toBe(false);
    expect(g.update(0.1, 0.1, 5, MAX)).toBe(false);
    g.update(0.1, 0.1, 5 + FRAME, MAX);
    g.reset();
    expect(g.update(0.9, 0.9, 5 + 2 * FRAME, MAX)).toBe(false);
  });

  it("is off when maxSpeed is 0", () => {
    const g = new PinchGuard();
    g.update(0.5, 0.1, 0, 0);
    expect(g.update(0.5, 0.9, FRAME, 0)).toBe(false);
  });
});

describe("nextPinch", () => {
  const ON = 0.04;
  const OFF = 0.07;

  it("starts and ends a pinch with hysteresis when not blocked", () => {
    expect(nextPinch(false, 0.03, ON, OFF, false)).toBe(true);
    expect(nextPinch(false, 0.05, ON, OFF, false)).toBe(false);
    expect(nextPinch(true, 0.05, ON, OFF, false)).toBe(true);
    expect(nextPinch(true, 0.08, ON, OFF, false)).toBe(false);
  });

  it("refuses to start a pinch while blocked", () => {
    expect(nextPinch(false, 0.01, ON, OFF, true)).toBe(false);
  });

  it("keeps and releases a held pinch normally while blocked, so a fast drag survives", () => {
    expect(nextPinch(true, 0.05, ON, OFF, true)).toBe(true);
    expect(nextPinch(true, 0.08, ON, OFF, true)).toBe(false);
  });
});
