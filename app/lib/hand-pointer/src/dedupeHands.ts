// The tracker sometimes reports one hand twice.
//
// With two hands allowed, MediaPipe can lock a second detection onto the hand
// it is already tracking, most often when that hand is close to the camera
// and fills much of the frame. The two copies sit almost on top of each other
// and may carry the same left/right label or opposite ones.
//
// Everything downstream assumes two detections are two hands. A duplicate
// becomes a phantom second hand that pinches whenever the real one does, so a
// one-handed pinch reads as a two-hand pinch and the canvas zooms a little
// with every bit of jitter between the copies. It would also double-count the
// hand for takeover. So copies are merged here, before anything else reads
// the detections.

import { handScale } from "./depthZone";

// Two detections are the same hand when their landmarks are, on average,
// closer than this fraction of the hand's size. Two real hands cannot get
// this close without overlapping in the image (and then the tracker cannot
// separate them anyway); two copies of one hand sit at a few percent.
export const SAME_HAND = 0.35;

export interface Detection {
  hand: "L" | "R";
  conf: number;
  pts: number[];
}

// Mean landmark distance between two detections, in hand sizes.
export function handOverlap(a: number[], b: number[], aspect = 1): number {
  const n = Math.min(a.length, b.length) / 2;
  if (n === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += Math.hypot((a[i * 2] - b[i * 2]) * aspect, a[i * 2 + 1] - b[i * 2 + 1]);
  }
  const size = Math.max(handScale(a, aspect), handScale(b, aspect));
  return size > 1e-9 ? sum / n / size : Infinity;
}

// Drop detections that duplicate an earlier-kept one. Of two copies, keep the
// one labelled as the hand that is driving (so a duplicate cannot change which
// hand drives or flip its label), else the more confident one.
export function dedupeHands<T extends Detection>(
  hands: T[],
  aspect = 1,
  prefer: "L" | "R" | null = null,
): T[] {
  if (hands.length < 2) return hands;
  const ranked = hands
    .slice()
    .sort((a, b) => Number(b.hand === prefer) - Number(a.hand === prefer) || b.conf - a.conf);
  const kept: T[] = [];
  for (const c of ranked) {
    if (!kept.some((k) => handOverlap(k.pts, c.pts, aspect) < SAME_HAND)) kept.push(c);
  }
  // Keep the tracker's original order among the survivors.
  return hands.filter((c) => kept.includes(c));
}
