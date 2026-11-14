import { describe, expect, it } from "vitest";
import {
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
  // Middle and ring knuckles: spaced between the other two, as on a real hand.
  pts[18] = (index[0] * 2 + pinky[0]) / 3;
  pts[19] = (index[1] * 2 + pinky[1]) / 3;
  pts[26] = (index[0] + pinky[0] * 2) / 3;
  pts[27] = (index[1] + pinky[1] * 2) / 3;
  // Finger middle joints (6, 10, 14, 18): half a knuckle's distance further
  // out from the wrist than each knuckle (5, 9, 13, 17).
  for (const [mcp, pip] of [[5, 6], [9, 10], [13, 14], [17, 18]]) {
    pts[pip * 2] = pts[mcp * 2] + (pts[mcp * 2] - wrist[0]) * 0.5;
    pts[pip * 2 + 1] = pts[mcp * 2 + 1] + (pts[mcp * 2 + 1] - wrist[1]) * 0.5;
  }
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
  it("is well above zero with the fingers up", () => {
    expect(fingersUp(rightPalm)).toBeGreaterThan(1);
  });

  it("stays positive for a hand lying sideways: its upper fingers are above the wrist", () => {
    expect(fingersUp(rotate(rightPalm, Math.PI / 2))).toBeGreaterThan(UP_ON);
    expect(fingersUp(rotate(rightPalm, -Math.PI / 2))).toBeGreaterThan(UP_ON);
  });

  it("is negative once all four finger middle joints are below the wrist", () => {
    expect(fingersUp(rotate(rightPalm, Math.PI))).toBeLessThan(UP_OFF);
    // Tipped down well past level, but not straight down: still all below.
    expect(fingersUp(rotate(rightPalm, (3 * Math.PI) / 4))).toBeLessThan(UP_OFF);
  });

  it("counts a hand foreshortened by a camera below it", () => {
    // Seen from underneath, the knuckles sit barely above the wrist and the
    // old angle test read this hand as lying level. The fingers are still up.
    const squashed = hand([0.5, 0.62], [0.58, 0.6], [0.42, 0.61]);
    expect(fingersUp(squashed)).toBeGreaterThan(UP_ON);
  });

  it("does not change with distance from the camera", () => {
    const near = rightPalm.map((v) => v * 1.5);
    expect(fingersUp(near)).toBeCloseTo(fingersUp(rightPalm), 6);
  });
});

describe("palmLength", () => {
  it("shrinks as the hand tips toward the camera", () => {
    // Tipped forward: the knuckles drop toward the wrist, the width stays.
    const tipped = hand([0.5, 0.8], [0.56, 0.74], [0.44, 0.76]);
    expect(palmLength(rightPalm)).toBeGreaterThan(1.2);
    expect(palmLength(tipped)).toBeLessThan(0.6);
  });

  it("does not change with distance or in-plane rotation", () => {
    const flat = palmLength(rightPalm);
    expect(palmLength(rightPalm.map((v) => v * 1.5))).toBeCloseTo(flat, 6);
    expect(palmLength(rotate(rightPalm, 1))).toBeCloseTo(flat, 6);
  });
});

describe("poseUsable", () => {
  const good = { palm: 0.6, up: 1, len: 1.4 };
  // Tipped toward the camera so the fingers nearly point at the lens: the
  // knuckles have closed in on the wrist, but the fingers are still above it.
  const tipped = hand([0.5, 0.8], [0.56, 0.76], [0.44, 0.77]);
  const tippedBack = hand([0.5, 0.8], [0.44, 0.76], [0.56, 0.77]);

  it("accepts a hand pointing at the camera while its fingers are above the wrist", () => {
    expect(palmLength(tipped)).toBeLessThan(0.5); // the old gate rejected this
    expect(fingersUp(tipped)).toBeGreaterThan(UP_ON);
    expect(palmFacing(tipped, "R")).toBeGreaterThan(PALM_ON);
    expect(poseUsable(handPose(tipped, "R"), false)).toBe(true);
  });

  it("still rejects the back of a hand pointing at the camera", () => {
    expect(palmFacing(tippedBack, "R")).toBeLessThan(-PALM_ON);
    expect(poseUsable(handPose(tippedBack, "R"), false)).toBe(false);
  });

  it("ignores len: it no longer gates the hand", () => {
    expect(poseUsable({ ...good, len: 0.1 }, false)).toBe(true);
    expect(poseUsable({ ...good, len: 0.1 }, true)).toBe(true);
  });


  it("accepts an upright, square-on palm and rejects each bad pose", () => {
    expect(poseUsable(handPose(rightPalm, "R"), false)).toBe(true);
    expect(poseUsable(handPose(rightBack, "R"), false)).toBe(false);
    expect(poseUsable(handPose(rotate(rightPalm, Math.PI), "R"), false)).toBe(false);
  });

  it("needs every measure past ON to start and any one below OFF to stop", () => {
    const mid = (on: number, off: number) => (on + off) / 2;
    for (const between of [
      { ...good, palm: mid(PALM_ON, PALM_OFF) },
      { ...good, up: mid(UP_ON, UP_OFF) },
    ]) {
      expect(poseUsable(between, false)).toBe(false);
      expect(poseUsable(between, true)).toBe(true);
    }
    expect(poseUsable({ ...good, up: UP_OFF - 0.01 }, true)).toBe(false);
  });
});
