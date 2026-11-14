import { describe, expect, it } from "vitest";
import {
  DRIVER_GRACE,
  EVIDENCE,
  HandArbiter,
  HandoffOffset,
  MAX_GAP,
  MOVE,
  MotionTracker,
  PinchLatch,
  REFRACTORY,
  REST_RATIO,
  palmSpan,
} from "../handArbiter";

type Side = "L" | "R";
const FRAME = 1 / 15; // inference rate
const PALM = 0.12; // a hand at a typical distance, in frame heights

describe("MotionTracker", () => {
  // A hand moving along x at `speed` (frame heights per second), sampled
  // every `dt` seconds for `seconds`. Returns the last reading.
  const steady = (dt: number, speed: number, seconds: number, palm = PALM) => {
    const tr = new MotionTracker();
    let v = 0;
    for (let t = 0; t <= seconds; t += dt) v = tr.update(0.1 + speed * t, 0.5, palm, t);
    return v;
  };

  it("reads the same for a steady speed whatever the frame interval", () => {
    const vs = [0.06, 0.0751, 0.083, 0.1].map((dt) => steady(dt, 0.3, 2));
    for (const v of vs) expect(v).toBeGreaterThan(MOVE);
    expect(Math.max(...vs) / Math.min(...vs)).toBeLessThan(1.1);
  });

  it("is not zeroed by one late frame mid-move, but is by a long gap", () => {
    const tr = new MotionTracker();
    const speed = 0.3;
    let t = 0;
    for (let i = 0; i < 10; i++, t += 0.075) tr.update(0.1 + speed * t, 0.5, PALM, t);
    const before = tr.value;
    t += 0.16 - 0.075; // one frame arrives 160 ms after the last
    expect(tr.update(0.1 + speed * t, 0.5, PALM, t)).toBeGreaterThan(before);
    t += 0.075;
    expect(tr.update(0.1 + speed * t, 0.5, PALM, t)).toBeGreaterThan(MOVE);
    t += MAX_GAP + 0.01;
    expect(tr.update(0.9, 0.9, PALM, t)).toBe(0); // long gap: not a move
  });

  it("gives the same reading for the same gesture nearer and further away", () => {
    // The whole picture scaled: positions and palm length together.
    const run = (scale: number) => {
      const tr = new MotionTracker();
      let v = 0;
      for (let i = 0; i < 12; i++) {
        v = tr.update(scale * (1 + 0.3 * i), scale * (2 + 0.1 * i), scale, i * 0.075);
      }
      return v;
    };
    expect(run(0.05)).toBeCloseTo(run(0.12), 9);
    expect(run(0.12)).toBeGreaterThan(MOVE);
  });

  it("stays below MOVE for a jittering but stationary hand", () => {
    const tr = new MotionTracker();
    for (let i = 0; i < 60; i++) {
      const v = tr.update(0.5 + (i % 2 ? 0.003 : -0.003), 0.5, PALM, i * FRAME);
      expect(v).toBeLessThan(MOVE);
    }
  });

  it("falls back below MOVE soon after a moved hand stops", () => {
    const tr = new MotionTracker();
    let t = 0;
    for (let i = 0; i < 10; i++, t += FRAME) tr.update(0.1 + 0.02 * i, 0.5, PALM, t);
    expect(tr.value).toBeGreaterThan(MOVE);
    let frames = 0;
    while (tr.update(0.28, 0.5, PALM, t) >= MOVE) {
      t += FRAME;
      frames++;
    }
    expect(frames * FRAME).toBeLessThan(0.5);
  });

  it("flags a there-and-back jump as a reversal, and a monotonic move not", () => {
    const tr = new MotionTracker();
    tr.update(0.5, 0.5, PALM, 0);
    tr.update(0.5, 0.5, PALM, FRAME);
    tr.update(0.6, 0.5, PALM, 2 * FRAME); // out
    expect(tr.reversal).toBe(false);
    tr.update(0.5, 0.5, PALM, 3 * FRAME); // and back
    expect(tr.reversal).toBe(true);
    tr.update(0.5, 0.5, PALM, 4 * FRAME);
    expect(tr.reversal).toBe(false);

    const mono = new MotionTracker();
    for (let i = 0; i < 20; i++) {
      mono.update(0.1 + 0.03 * i, 0.5, PALM, i * FRAME);
      expect(mono.reversal).toBe(false);
    }
  });

  it("does not let a there-and-back jump leave motion behind", () => {
    // Without undoing the lag, the frames after the glitch read as motion
    // while the lag drifts back (about 0.5 and 0.36 palm lengths here).
    const tr = new MotionTracker();
    tr.update(0.5, 0.5, PALM, 0);
    tr.update(0.5, 0.5, PALM, FRAME);
    tr.update(0.8, 0.5, PALM, 2 * FRAME);
    for (let i = 3; i < 10; i++) expect(tr.update(0.5, 0.5, PALM, i * FRAME)).toBeLessThan(0.01);
  });

  it("ignores a zero or non-finite palm length", () => {
    const tr = new MotionTracker();
    tr.update(0.1, 0.5, PALM, 0);
    const good = tr.update(0.13, 0.5, PALM, FRAME);
    for (const [i, bad] of [0, NaN, Infinity, -1].entries()) {
      const v = tr.update(0.13 + 0.03 * (i + 1), 0.5, bad, (i + 2) * FRAME);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(good);
    }
    // A hand that has never had a usable palm cannot be measured: reads 0.
    const none = new MotionTracker();
    none.update(0.1, 0.5, 0, 0);
    expect(none.update(0.5, 0.5, NaN, FRAME)).toBe(0);
  });

  it("starts again after a reset", () => {
    const tr = new MotionTracker();
    tr.update(0.1, 0.1, PALM, 0);
    tr.update(0.2, 0.2, PALM, FRAME);
    expect(tr.value).toBeGreaterThan(0);
    tr.reset();
    expect(tr.value).toBe(0);
    expect(tr.reversal).toBe(false);
    expect(tr.update(0.8, 0.8, PALM, 2 * FRAME)).toBe(0);
  });

  it("measures the palm from wrist to middle knuckle, aspect-corrected", () => {
    const pts = new Array(42).fill(0);
    pts[0] = 0.5; // wrist
    pts[1] = 0.8;
    pts[18] = 0.53; // middle knuckle
    pts[19] = 0.76;
    expect(palmSpan(pts, 1)).toBeCloseTo(0.05, 9);
    expect(palmSpan(pts, 4 / 3)).toBeCloseTo(Math.hypot(0.04, 0.04), 9);
  });
});

describe("HandArbiter", () => {
  const STILL = 0.02;
  const CLEAR = 0.6; // well past the bar: full gain
  const none = {};

  // An arbiter with both hands in frame and R driving.
  const started = () => {
    const a = new HandArbiter();
    a.update({ L: STILL, R: STILL }, none, false, "R", 0);
    return a;
  };

  // Feed the same reading every `dt` from `from` (exclusive) for `seconds`.
  // Returns the time of the first frame on which `to` drives, or NaN.
  const feed = (
    a: HandArbiter,
    motion: Partial<Record<Side, number>>,
    from: number,
    seconds: number,
    to: Side,
    opt: { locked?: boolean; dt?: number } = {},
  ) => {
    const dt = opt.dt ?? FRAME;
    let at = NaN;
    const frames = Math.round(seconds / dt);
    for (let i = 1; i <= frames; i++) {
      const t = from + i * dt;
      const d = a.update(motion, none, opt.locked ?? false, "R", t);
      if (d === to && Number.isNaN(at)) at = t;
    }
    return at;
  };

  it("lets a single hand drive, whichever it is", () => {
    expect(new HandArbiter().update({ L: STILL }, none, false, "R", 0)).toBe("L");
    expect(new HandArbiter().update({ R: STILL }, none, false, "L", 0)).toBe("R");
    expect(new HandArbiter().update({}, none, false, "R", 0)).toBeNull();
  });

  it("starts with the preferred hand when both appear together", () => {
    expect(new HandArbiter().update({ L: STILL, R: STILL }, none, false, "L", 0)).toBe("L");
    expect(new HandArbiter().update({ L: CLEAR, R: STILL }, none, false, "R", 0)).toBe("R");
  });

  it("keeps the hand already driving when a second one joins", () => {
    const a = new HandArbiter();
    a.update({ L: CLEAR }, none, false, "R", 0);
    expect(feed(a, { L: CLEAR, R: STILL }, 0, 1, "R")).toBeNaN();
  });

  it("obeys a change of preferred hand at once, unless locked", () => {
    const a = started();
    expect(a.update({ L: STILL, R: STILL }, none, false, "L", FRAME)).toBe("L");
    const b = started();
    expect(b.update({ L: STILL, R: STILL }, none, true, "L", FRAME)).toBe("R");
  });

  it("switches to a clearly moving hand on the second frame, never the first", () => {
    for (const dt of [0.03, FRAME, 0.1, 0.17, 5]) {
      const a = started();
      const reading = { L: CLEAR, R: STILL };
      expect(a.update(reading, none, false, "R", 1)).toBe("R");
      expect(a.why).toBe("evidence");
      if (dt >= 0.04) {
        expect(a.update(reading, none, false, "R", 1 + dt)).toBe("L");
        expect(a.why).toBe("switched");
        expect(a.evidence).toBe(0);
      }
    }
    // The same frame delivered twice is still one frame.
    const a = started();
    a.update({ L: CLEAR, R: STILL }, none, false, "R", 1);
    expect(a.update({ L: CLEAR, R: STILL }, none, false, "R", 1)).toBe("R");
  });

  it("switches to a marginally moving hand within about 0.4 s", () => {
    const a = started();
    const at = feed(a, { L: MOVE * 1.3, R: 0 }, 0, 1, "L");
    expect(at).toBeGreaterThan(2 * FRAME + 1e-9); // slower than a clear move
    expect(at).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it("is delayed, not restarted, by one failing frame during a clear move", () => {
    const a = started();
    const move = { L: CLEAR, R: STILL };
    a.update(move, none, false, "R", 1);
    // Frame 2 would have switched. Instead both hands move for one frame.
    expect(a.update({ L: CLEAR, R: CLEAR }, none, false, "R", 1 + FRAME)).toBe("R");
    expect(a.why).toBe("driver moving");
    expect(a.evidence).toBeGreaterThan(0); // leaked, not thrown away
    expect(a.update(move, none, false, "R", 1 + 2 * FRAME)).toBe("R");
    // Frame 4: two frames later than without the interruption.
    expect(a.update(move, none, false, "R", 1 + 3 * FRAME)).toBe("L");
  });

  it("loses a frame's worth of evidence to a failing frame during a marginal move", () => {
    // What the design does NOT guarantee. One failing frame leaks
    // LEAK * dt = 0.067 s of evidence, while a move at 1.3 x MOVE earns only
    // 0.02 s per frame, so here the failing frame wipes the evidence out and
    // the wait starts over (0.4 s later instead of at most two frames).
    const a = started();
    const move = { L: MOVE * 1.3, R: 0 };
    a.update(move, none, false, "R", FRAME);
    a.update(move, none, false, "R", 2 * FRAME);
    a.update(move, none, false, "R", 3 * FRAME);
    expect(a.evidence).toBeGreaterThan(0.7); // one more frame would switch
    a.update({ L: 0, R: 0 }, none, false, "R", 4 * FRAME);
    expect(a.evidence).toBe(0);
    const at = feed(a, move, 4 * FRAME, 1, "L");
    expect(at - 4 * FRAME).toBeGreaterThan(3 * FRAME);
    expect(at - 4 * FRAME).toBeLessThanOrEqual(0.4 + 1e-9);
  });

  it("does not flip straight back, and does once the refractory period is over", () => {
    const a = started();
    const t0 = feed(a, { L: CLEAR, R: STILL }, 1, 1, "L");
    expect(t0).not.toBeNaN();
    // The old driver now moves at 1.5 x MOVE while the new one rests: enough
    // to take the cursor normally, not enough against the doubled bar.
    const a2 = new HandArbiter();
    a2.update({ L: STILL, R: STILL }, none, false, "L", 0);
    expect(feed(a2, { L: 0, R: MOVE * 1.5 }, 0, 0.5, "R")).not.toBeNaN(); // the control

    const b = started();
    b.update({ L: CLEAR, R: STILL }, none, false, "R", 1);
    b.update({ L: CLEAR, R: STILL }, none, false, "R", 1 + FRAME);
    expect(b.driver).toBe("L");
    const sw = 1 + FRAME;
    const back = { L: 0, R: MOVE * 1.5 };
    let t = sw;
    while (t + FRAME < sw + 0.5) {
      t += FRAME;
      expect(b.update(back, none, false, "R", t)).toBe("L");
    }
    let at = NaN;
    while (t < sw + REFRACTORY + 0.5 && Number.isNaN(at)) {
      t += FRAME;
      if (b.update(back, none, false, "R", t) === "R") at = t;
    }
    expect(at).toBeGreaterThanOrEqual(sw + REFRACTORY);
    expect(at).toBeLessThan(sw + REFRACTORY + 0.3);
  });

  it("still switches when frames arrive 0.17 s apart throughout", () => {
    const a = new HandArbiter();
    a.update({ L: STILL, R: STILL }, none, false, "R", 0);
    feed(a, { L: STILL, R: STILL }, 0, 1.02, "L", { dt: 0.17 });
    expect(a.driver).toBe("R");
    expect(feed(a, { L: CLEAR, R: STILL }, 1.02, 0.34, "L", { dt: 0.17 })).toBeCloseTo(1.36, 9);
    const b = new HandArbiter();
    b.update({ L: STILL, R: STILL }, none, false, "R", 0);
    expect(feed(b, { L: MOVE * 1.3, R: 0 }, 0, 0.51, "L", { dt: 0.17 })).not.toBeNaN();
  });

  it("keeps a driver that drops out for one to three frames", () => {
    for (const missing of [1, 2, 3]) {
      const a = started();
      let t = 0;
      for (let i = 0; i < missing; i++) {
        t += FRAME;
        expect(a.update({ L: CLEAR }, none, false, "R", t)).toBe("R");
        expect(a.why).toBe("grace");
      }
      // Back again: still the driver, and the absence earned L nothing.
      t += FRAME;
      expect(a.update({ L: STILL, R: STILL }, none, false, "R", t)).toBe("R");
      expect(a.evidence).toBe(0);
    }
  });

  it("hands over once the driver has been missing for DRIVER_GRACE", () => {
    const a = started();
    let t = 0;
    let at = NaN;
    for (let i = 0; i < 10 && Number.isNaN(at); i++) {
      t += FRAME;
      if (a.update({ L: STILL }, none, false, "R", t) === "L") at = t;
    }
    expect(at).toBeGreaterThanOrEqual(DRIVER_GRACE);
    expect(at).toBeLessThan(DRIVER_GRACE + FRAME);
    expect(a.why).toBe("switched");
    // Counted from when the driver was last seen, not from the last call:
    // a dropout of both hands in between does not restart the wait.
    const b = started();
    b.update({}, none, false, "R", 0.1);
    b.update({}, none, false, "R", 0.2);
    expect(b.update({ L: STILL }, none, false, "R", 0.24)).toBe("R");
    expect(b.update({ L: STILL }, none, false, "R", 0.26)).toBe("L");
  });

  it("never hands over from a missing driver while locked", () => {
    const a = started();
    for (let t = FRAME; t < 5; t += FRAME) {
      expect(a.update({ L: CLEAR }, none, true, "R", t)).toBe("R");
      expect(a.why).toBe("grace");
    }
    // The lock lifts (the caller ended the pinch): now it goes.
    expect(a.update({ L: CLEAR }, none, false, "R", 5)).toBe("L");
  });

  it("raises the bar after taking over from a driver that went missing", () => {
    const a = started();
    feed(a, { L: STILL }, 0, 0.4, "L");
    expect(a.driver).toBe("L");
    // R comes back and moves a little: not enough inside the refractory period.
    expect(feed(a, { L: 0, R: MOVE * 1.5 }, 0.4, 0.4, "R")).toBeNaN();
  });

  it("never switches while both hands move", () => {
    for (const reading of [
      { L: CLEAR, R: CLEAR },
      { L: MOVE * 3, R: MOVE * 3 * 0.7 }, // the driver at 0.7 x the other
      { L: STILL, R: STILL },
      { L: MOVE * 0.9, R: 0 },
    ]) {
      const a = started();
      expect(feed(a, reading, 0, 5, "L")).toBeNaN();
      expect(a.evidence).toBe(0);
    }
  });

  it("counts a swaying driver as resting when the other hand moves much further", () => {
    const a = started();
    expect(feed(a, { L: MOVE * 5, R: MOVE * 2 }, 0, 1, "L")).not.toBeNaN();
  });

  it("throws the evidence away on a frame flagged as a reversal", () => {
    const a = started();
    const move = { L: CLEAR, R: STILL };
    a.update(move, none, false, "R", 1);
    expect(a.evidence).toBe(1);
    expect(a.update(move, { L: true }, false, "R", 1 + FRAME)).toBe("R");
    expect(a.why).toBe("glitch");
    expect(a.evidence).toBe(0);
    // A reversal on the driving hand is not the other hand's glitch.
    const b = started();
    b.update(move, none, false, "R", 1);
    expect(b.update(move, { R: true }, false, "R", 1 + FRAME)).toBe("L");
  });

  it("never switches while locked", () => {
    const a = started();
    expect(feed(a, { L: CLEAR, R: STILL }, 0, 2, "L", { locked: true })).toBeNaN();
    expect(a.why).toBe("pinch");
    expect(a.evidence).toBe(0);
  });

  it("remembers the driver through a dropout of both hands", () => {
    const a = started();
    feed(a, { L: CLEAR, R: STILL }, 0, 1, "L");
    expect(a.driver).toBe("L");
    expect(a.update({}, none, false, "R", 2)).toBeNull();
    expect(a.update({ L: STILL, R: STILL }, none, false, "R", 2 + FRAME)).toBe("L");
  });

  it("reports evidence as 0..1 and forgets everything on reset", () => {
    const a = started();
    a.update({ L: MOVE * 1.5, R: 0 }, none, false, "R", FRAME);
    expect(a.evidence).toBeCloseTo((0.5 * FRAME) / EVIDENCE, 9);
    a.reset();
    expect(a.driver).toBeNull();
    expect(a.evidence).toBe(0);
    expect(a.why).toBe("");
    expect(a.update({ L: STILL, R: STILL }, none, false, "L", 9)).toBe("L");
  });
});

describe("MotionTracker with HandArbiter", () => {
  // mulberry32: a small deterministic PRNG, so the soak is the same every run.
  const prng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  // Box-Muller.
  const gaussian = (rand: () => number) => () =>
    Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

  // Both hands through tracker and arbiter. pos(side, i) is the knuckle
  // position on frame i. Returns the number of handovers.
  const run = (
    frames: number,
    dt: number,
    pos: (side: Side, i: number) => { x: number; y: number },
  ) => {
    const tr = { L: new MotionTracker(), R: new MotionTracker() };
    const a = new HandArbiter();
    let switches = 0;
    let last: Side | null = null;
    firstSwitchAt = NaN;
    for (let i = 0; i < frames; i++) {
      const t = i * dt;
      const motion: Partial<Record<Side, number>> = {};
      const reversal: Partial<Record<Side, boolean>> = {};
      const onset: Partial<Record<Side, number>> = {};
      for (const side of ["L", "R"] as const) {
        const p = pos(side, i);
        motion[side] = tr[side].update(p.x, p.y, PALM, t);
        reversal[side] = tr[side].reversal;
        onset[side] = tr[side].onset;
      }
      const d = a.update(motion, reversal, false, "R", t, onset);
      if (last !== null && d !== last) {
        switches++;
        if (Number.isNaN(firstSwitchAt)) firstSwitchAt = t;
      }
      last = d;
    }
    return switches;
  };
  // Time of the first handover in the last run(), or NaN.
  let firstSwitchAt = NaN;

  // The driving hand (R) keeps drifting sideways at a steady pace the whole
  // time; at START the other hand (L) begins to move.
  const START = 3;
  const drifting = (driverSpeed: number, otherSpeed: (t: number) => number) =>
    (side: Side, i: number) => {
      const t = i * FRAME;
      if (side === "R") return { x: 1.0 + driverSpeed * t, y: 0.5 };
      let x = 0.4;
      for (let k = 0; k < i; k++) x += otherSpeed(k * FRAME) * FRAME;
      return { x, y: 0.5 };
    };

  it("hands over when the other hand speeds up, even while the driver keeps moving", () => {
    // Driver at 1 palm/s, steady. The other hand starts from rest at 1.5
    // palm/s: only 1.5x the driver, under the 1/REST_RATIO (1.67x) that plain
    // motion needs, so before this it never took over.
    const otherSpeed = 1.5 * PALM;
    expect(otherSpeed / PALM).toBeLessThan(1 / REST_RATIO);
    const switches = run(Math.round((START + 2) / FRAME), FRAME, drifting(PALM, (t) => (t < START ? 0 : otherSpeed)));
    expect(switches).toBe(1);
    expect(firstSwitchAt - START).toBeLessThan(0.4);
  });

  it("does not hand over when both hands speed up together", () => {
    const speed = (t: number) => (t < START ? 0.3 * PALM : 1.5 * PALM);
    const pos = (side: Side, i: number) => {
      const t = i * FRAME;
      let x = side === "R" ? 1.0 : 0.4;
      for (let k = 0; k < i; k++) x += speed(k * FRAME) * FRAME;
      return { x, y: 0.5 + (side === "R" ? 0 : 0.2) + 0 * t };
    };
    expect(run(Math.round((START + 3) / FRAME), FRAME, pos)).toBe(0);
  });

  it("does not hand over to a hand that has been moving steadily all along", () => {
    // The other hand is not speeding up: it just moves at the same pace as the
    // driver. That is two hands moving alike, not a takeover.
    const switches = run(Math.round(6 / FRAME), FRAME, drifting(PALM, () => PALM));
    expect(switches).toBe(0);
  });

  it("hands over to a hand waving to take the cursor, not mistaking the wave for a glitch (regression guard)", () => {
    // The other hand waves from START; the driver rests. At these rates the
    // camera samples the wave only two or three times per swing, so its steps
    // alternate direction, which is what a glitch looks like.
    for (const hz of [3, 4, 5, 6]) {
      for (const amp of [0.4, 0.8]) {
        const switches = run(Math.round((START + 2) / FRAME), FRAME, (side, i) => {
          const t = i * FRAME;
          if (side === "R") return { x: 1.0, y: 0.5 };
          const w = t < START ? 0 : amp * PALM * Math.sin(2 * Math.PI * hz * (t - START));
          return { x: 0.4 + w, y: 0.5 };
        });
        expect(switches, `${hz} Hz, ${amp} palm`).toBe(1);
        expect(firstSwitchAt - START, `${hz} Hz, ${amp} palm`).toBeLessThan(0.6);
      }
    }
  });

  it("never switches between two still hands over 60 s of tracker jitter", () => {
    const SIGMA = 0.004; // frame heights, per axis
    for (const seed of [1, 2, 3, 4, 5]) {
      const g = gaussian(prng(seed));
      const switches = run(60 * 13, 1 / 13, (side) => ({
        x: (side === "L" ? 0.4 : 1.0) + SIGMA * g(),
        y: 0.5 + SIGMA * g(),
      }));
      expect(switches).toBe(0);
    }
  });

  it("does not switch on a one-frame jump of the resting hand, however large", () => {
    for (const jump of [0.03, 0.06, 0.1, 0.2, 0.3, 0.6]) {
      const switches = run(60, FRAME, (side, i) => ({
        x: side === "R" ? 1.0 : i === 20 ? 0.4 + jump : 0.4,
        y: 0.5,
      }));
      expect(switches).toBe(0);
    }
  });

  it("switches once when the resting hand starts to point", () => {
    // L sits still for a second, then moves at 0.3 frame heights per second.
    const start = 15;
    let first = NaN;
    const tr = { L: new MotionTracker(), R: new MotionTracker() };
    const a = new HandArbiter();
    for (let i = 0; i < 45; i++) {
      const t = i * FRAME;
      const lx = 0.4 + (i > start ? 0.3 * (i - start) * FRAME : 0);
      const motion = {
        L: tr.L.update(lx, 0.5, PALM, t),
        R: tr.R.update(1.0, 0.5, PALM, t),
      };
      const d = a.update(motion, { L: tr.L.reversal, R: tr.R.reversal }, false, "R", t);
      if (d === "L" && Number.isNaN(first)) first = i;
      if (!Number.isNaN(first)) expect(d).toBe("L");
    }
    // Under a quarter of a second after the hand starts moving.
    expect(first - start).toBeGreaterThanOrEqual(2);
    expect((first - start) * FRAME).toBeLessThan(0.25);
  });
});

describe("PinchLatch", () => {
  const OFF = 0.07;

  it("passes the pinch straight through when there has been no handover", () => {
    const l = new PinchLatch();
    expect(l.update(false, true, 0.02, OFF)).toBe(true);
    expect(l.update(false, false, 0.2, OFF)).toBe(false);
    expect(l.update(false, true, 0.02, OFF)).toBe(true);
  });

  it("does not press when a hand that is already pinched takes over", () => {
    const l = new PinchLatch();
    expect(l.update(true, true, 0.02, OFF)).toBe(false);
    for (let i = 0; i < 20; i++) expect(l.update(false, true, 0.03, OFF)).toBe(false);
    expect(l.on).toBe(true);
  });

  it("presses again once the hand has opened and pinched anew", () => {
    const l = new PinchLatch();
    l.update(true, true, 0.02, OFF);
    expect(l.update(false, false, 0.09, OFF)).toBe(false); // opened: latch off
    expect(l.on).toBe(false);
    expect(l.update(false, true, 0.02, OFF)).toBe(true);
  });

  it("does not latch a hand that takes over open", () => {
    const l = new PinchLatch();
    expect(l.update(true, false, 0.15, OFF)).toBe(false);
    expect(l.on).toBe(false);
    expect(l.update(false, true, 0.02, OFF)).toBe(true);
  });

  it("stays latched while the gap sits between the pinch thresholds", () => {
    // A hand resting half-closed (gap under pinchOff, not pinched) takes
    // over and then closes without ever opening: still no press.
    const l = new PinchLatch();
    expect(l.update(true, false, 0.05, OFF)).toBe(false);
    expect(l.update(false, true, 0.03, OFF)).toBe(false);
    // Releasing at exactly the threshold clears it, as it ends the pinch.
    expect(l.update(false, false, OFF, OFF)).toBe(false);
    expect(l.on).toBe(false);
  });

  it("clears on reset", () => {
    const l = new PinchLatch();
    l.update(true, true, 0.02, OFF);
    l.reset();
    expect(l.update(false, true, 0.02, OFF)).toBe(true);
  });
});

describe("HandoffOffset", () => {
  it("passes positions through untouched until a handover", () => {
    expect(new HandoffOffset().apply(300, 200, 0.5)).toEqual({ x: 300, y: 200 });
  });

  it("keeps the cursor in place at the handover and while the new hand is still", () => {
    const o = new HandoffOffset();
    o.begin(800, 400, 200, 300);
    expect(o.apply(200, 300, 0.5)).toEqual({ x: 800, y: 400 });
    expect(o.apply(200, 300, 0.5)).toEqual({ x: 800, y: 400 });
  });

  it("never jumps: the cursor moves no further than the hand does, plus the drain", () => {
    const o = new HandoffOffset();
    o.begin(800, 400, 200, 300);
    let prev = o.apply(200, 300, 0.5);
    for (let i = 1; i <= 40; i++) {
      const cur = o.apply(200 + i * 10, 300, 0.5);
      expect(Math.hypot(cur.x - prev.x, cur.y - prev.y)).toBeLessThanOrEqual(10 * 1.5 + 1e-9);
      prev = cur;
    }
  });

  it("blends back to the hand's true position as it travels", () => {
    const o = new HandoffOffset();
    o.begin(800, 400, 200, 300); // offset is about 608px long
    let cur = { x: 0, y: 0 };
    for (let i = 1; i <= 130; i++) cur = o.apply(200 + i * 10, 300, 0.5);
    expect(cur).toEqual({ x: 1500, y: 300 });
    expect(o.x).toBe(0);
    expect(o.y).toBe(0);
  });

  it("forgets the offset when cleared", () => {
    const o = new HandoffOffset();
    o.begin(800, 400, 200, 300);
    o.clear();
    expect(o.apply(250, 350, 0.5)).toEqual({ x: 250, y: 350 });
  });

});
