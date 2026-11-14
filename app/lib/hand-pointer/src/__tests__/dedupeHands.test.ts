import { describe, expect, it } from "vitest";
import { SAME_HAND, dedupeHands, handOverlap, type Detection } from "../dedupeHands";

// A rough hand: wrist, knuckles and fingertips around (cx, cy), size s.
const handAt = (cx: number, cy: number, s = 0.12): number[] => {
  const pts: number[] = [];
  for (let i = 0; i < 21; i++) {
    const a = (i / 21) * Math.PI - Math.PI; // fan the landmarks over a half circle
    const r = i === 0 ? 0 : s * (0.6 + 0.4 * ((i % 4) / 3));
    pts.push(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r);
  }
  // Make the palm segments handScale reads well defined.
  pts[10] = cx + s * 0.3;
  pts[11] = cy - s;
  pts[34] = cx - s * 0.3;
  pts[35] = cy - s * 0.9;
  return pts;
};

const det = (hand: "L" | "R", conf: number, pts: number[]): Detection => ({ hand, conf, pts });
const jitter = (pts: number[], d: number) => pts.map((v, i) => v + (i % 3 === 0 ? d : -d));

describe("handOverlap", () => {
  it("is near zero for copies of one hand and large for two hands apart", () => {
    const a = handAt(0.4, 0.6);
    expect(handOverlap(a, jitter(a, 0.004))).toBeLessThan(0.1);
    expect(handOverlap(a, handAt(0.7, 0.6))).toBeGreaterThan(SAME_HAND * 3);
  });
});

describe("dedupeHands", () => {
  it("keeps two real hands", () => {
    const hands = [det("R", 0.9, handAt(0.3, 0.6)), det("L", 0.9, handAt(0.7, 0.6))];
    expect(dedupeHands(hands)).toHaveLength(2);
  });

  it("merges a copy with the same label into one hand", () => {
    const a = handAt(0.4, 0.6);
    const hands = [det("R", 0.8, a), det("R", 0.95, jitter(a, 0.005))];
    const out = dedupeHands(hands);
    expect(out).toHaveLength(1);
    expect(out[0].conf).toBe(0.95); // the more confident copy
  });

  it("merges a copy with the opposite label, keeping the driving hand's label", () => {
    const a = handAt(0.4, 0.6);
    const hands = [det("R", 0.7, a), det("L", 0.95, jitter(a, 0.005))];
    expect(dedupeHands(hands, 1, "R").map((h) => h.hand)).toEqual(["R"]);
    expect(dedupeHands(hands, 1, null).map((h) => h.hand)).toEqual(["L"]);
  });

  it("leaves a single hand and an empty frame alone", () => {
    const one = [det("R", 0.9, handAt(0.5, 0.5))];
    expect(dedupeHands(one)).toBe(one);
    expect(dedupeHands([])).toEqual([]);
  });

  it("keeps the tracker's order", () => {
    const hands = [det("L", 0.5, handAt(0.7, 0.6)), det("R", 0.9, handAt(0.3, 0.6))];
    expect(dedupeHands(hands, 1, "R").map((h) => h.hand)).toEqual(["L", "R"]);
  });
});
