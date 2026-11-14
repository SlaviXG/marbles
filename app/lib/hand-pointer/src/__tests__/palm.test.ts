import { describe, expect, it } from "vitest";
import {
  LEN_OFF,
  LEN_ON,
  PALM_OFF,
  PALM_ON,
  UP_OFF,
  UP_ON,
  fingersUp,
  handPose,
  palmFacing,
  palmLength,
  poseUsable,
} from "../palm";

// 21 landmarks with only the three the palm test reads filled in. Raw camera
// frame: x grows to the right of the image, y grows downward.
const hand = (wrist: [number, number], index: [number, number], pinky: [number, number]) => {
  const pts = new Array<number>(42).fill(0);
  pts[0] = wrist[0];
  pts[1] = wrist[1];
  pts[10] = index[0];
  pts[11] = index[1];
  pts[34] = pinky[0];
  pts[35] = pinky[1];
  // Middle knuckle: halfway between the other two, as on a real hand.
  pts[18] = (index[0] + pinky[0]) / 2;
  pts[19] = (index[1] + pinky[1]) / 2;
  return pts;
};

// A right hand, fingers up, palm toward the camera: the index knuckle sits at
// larger x than the pinky knuckle in the unmirrored frame.
const rightPalm = hand([0.5, 0.8], [0.56, 0.6], [0.44, 0.62]);
// The same hand turned round: the knuckles swap sides.
const rightBack = hand([0.5, 0.8], [0.44, 0.6], [0.56, 0.62]);

const rotate = (pts: number[], rad: number) => {
  const out = pts.slice();
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] - 0.5;
    const y = pts[i + 1] - 0.5;
    out[i] = 0.5 + x * Math.cos(rad) - y * Math.sin(rad);
    out[i + 1] = 0.5 + x * Math.sin(rad) + y * Math.cos(rad);
  }
  return out;
};

describe("palmFacing", () => {
  it("is positive for a right hand showing its palm and negative for its back", () => {
    expect(palmFacing(rightPalm, "R")).toBeGreaterThan(PALM_ON);
    expect(palmFacing(rightBack, "R")).toBeLessThan(-PALM_ON);
  });

  it("mirrors for the left hand", () => {
    // A left palm looks like a right hand's back, and the other way round.
    expect(palmFacing(rightBack, "L")).toBeGreaterThan(PALM_ON);
    expect(palmFacing(rightPalm, "L")).toBeLessThan(-PALM_ON);
  });

  it("does not change when the hand rotates in the image plane", () => {
    const upright = palmFacing(rightPalm, "R");
    for (const deg of [45, 90, 180, 270]) {
      expect(palmFacing(rotate(rightPalm, (deg * Math.PI) / 180), "R")).toBeCloseTo(upright, 6);
    }
  });

  it("does not change with distance from the camera", () => {
    const near = rightPalm.map((v) => v * 1.5);
    expect(palmFacing(near, "R")).toBeCloseTo(palmFacing(rightPalm, "R"), 6);
  });

  it("is zero for an edge-on or degenerate hand", () => {
    expect(palmFacing(hand([0.5, 0.8], [0.5, 0.6], [0.5, 0.62]), "R")).toBeCloseTo(0, 6);
    expect(palmFacing(new Array<number>(42).fill(0.5), "R")).toBe(0);
  });
});

describe("fingersUp", () => {
  it("is 1 pointing up, 0 lying level and negative hanging down", () => {
    expect(fingersUp(rightPalm)).toBeGreaterThan(0.95);
    expect(fingersUp(rotate(rightPalm, Math.PI / 2))).toBeCloseTo(0, 1);
    expect(fingersUp(rotate(rightPalm, Math.PI))).toBeLessThan(-0.95);
  });

  it("corrects for a non-square frame", () => {
    // 45 degrees in real space reads steeper in normalized coords on a wide
    // frame, because x is squeezed; the aspect puts it back.
    const tilted = hand([0.5, 0.8], [0.65, 0.6], [0.65, 0.6]);
    expect(fingersUp(tilted, 4 / 3)).toBeCloseTo(Math.SQRT1_2, 6);
  });
});

describe("palmLength", () => {
  it("shrinks as the hand tips toward the camera", () => {
    const flat = palmLength(rightPalm);
    // Tipped forward: the knuckles drop toward the wrist, the width stays.
    const tipped = hand([0.5, 0.8], [0.56, 0.74], [0.44, 0.76]);
    expect(flat).toBeGreaterThan(LEN_ON);
    expect(palmLength(tipped)).toBeLessThan(LEN_OFF);
  });

  it("does not change with distance or in-plane rotation", () => {
    const flat = palmLength(rightPalm);
    expect(palmLength(rightPalm.map((v) => v * 1.5))).toBeCloseTo(flat, 6);
    expect(palmLength(rotate(rightPalm, 1))).toBeCloseTo(flat, 6);
  });
});

describe("poseUsable", () => {
  const good = { palm: 0.6, up: 1, len: 1.4 };

  it("accepts an upright, square-on palm and rejects each bad pose", () => {
    expect(poseUsable(handPose(rightPalm, "R"), false)).toBe(true);
    expect(poseUsable(handPose(rightBack, "R"), false)).toBe(false);
    expect(poseUsable(handPose(rotate(rightPalm, Math.PI / 2), "R"), false)).toBe(false);
    expect(poseUsable(handPose(rotate(rightPalm, Math.PI), "R"), false)).toBe(false);
    expect(poseUsable({ ...good, len: 0.3 }, false)).toBe(false);
  });

  it("needs every measure past ON to start and any one below OFF to stop", () => {
    const mid = (on: number, off: number) => (on + off) / 2;
    for (const between of [
      { ...good, palm: mid(PALM_ON, PALM_OFF) },
      { ...good, up: mid(UP_ON, UP_OFF) },
      { ...good, len: mid(LEN_ON, LEN_OFF) },
    ]) {
      expect(poseUsable(between, false)).toBe(false);
      expect(poseUsable(between, true)).toBe(true);
    }
    expect(poseUsable({ ...good, up: UP_OFF - 0.01 }, true)).toBe(false);
  });
});
