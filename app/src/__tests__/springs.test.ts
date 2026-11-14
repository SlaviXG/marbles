import { describe, it, expect } from "vitest";
import { SPRINGS, springDisplacement, springProgress, springSettleTime } from "../motion/springs";

describe("springs (closed-form damped oscillator)", () => {
  it("starts at the initial displacement", () => {
    expect(springDisplacement(SPRINGS.calm, 0, 1, 0)).toBeCloseTo(1, 6);
  });

  it("progress starts at 0 and approaches 1", () => {
    expect(springProgress("calm", 0)).toBeCloseTo(0, 6);
    expect(springProgress("calm", 1)).toBeGreaterThan(0.99);
  });

  it("critically damped never overshoots", () => {
    for (let t = 0; t <= 1; t += 0.05) {
      expect(springProgress("calm", t)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("underdamped overshoots past the target", () => {
    let max = 0;
    for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, springProgress("lively", t));
    expect(max).toBeGreaterThan(1);
  });

  it("settle time is positive and finite", () => {
    const s = springSettleTime("calm");
    expect(s).toBeGreaterThan(0);
    expect(Number.isFinite(s)).toBe(true);
  });
});
