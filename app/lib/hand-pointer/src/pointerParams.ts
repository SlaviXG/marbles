// Single source of truth for the camera-cursor tuning. The future parameter
// tweaking app edits these and saves to the SAME localStorage key, so the main
// app picks them up (live, via the storage event). Keep this module dependency
// free so both apps can import it as-is.

export interface PointerParams {
  // One Euro filter (de-jitter the fingertip). See oneEuro.ts.
  minCutoff: number;
  beta: number;
  // Active zone: the sub-rectangle of the camera frame (normalized, after the
  // mirror) that maps to the whole screen, so a small hand movement spans it and
  // the arm need not sweep the full FOV. x0<x1, y0<y1 in 0..1.
  zoneX0: number;
  zoneY0: number;
  zoneX1: number;
  zoneY1: number;
  // Deadzone (screen px): movement below this from the held point is ignored, to
  // kill residual micro-jitter when holding still.
  deadzone: number;
  // Cap on how often we run inference (fps). Frames above this are dropped; the
  // cursor still renders at display rate via the spring (see HandCursor).
  maxInferenceFps: number;
  // Pinch-to-press: normalized thumb-tip to index-tip distance. Below pinchOn =
  // press; above pinchOff = release. The gap (hysteresis) stops click flicker.
  // The only press gesture: drag, scroll, click, and (with both hands) zoom.
  pinchOn: number;
  pinchOff: number;
  // A pinch cannot start while the palm moves faster than this (frame heights
  // per second), or just after: a fast sweep blurs the fingertips together
  // and reads as a pinch nobody made (see pinchGuard.ts). A pinch already
  // held is not affected, so drags can be fast. 0 turns the guard off.
  pinchMaxSpeed: number;
  // The cursor aims from the index knuckle plus a remembered finger offset,
  // frozen while the fingers close, so a pinch does not drag the cursor down
  // with the fingertip (see aimPoint.ts for each of these). aimTau 0 goes back
  // to the raw fingertip.
  aimTau: number;
  aimFreezeDist: number;
  aimFreezeRate: number;
  aimHoldMs: number;
  // Only use a hand held up with its palm facing the camera; one seen from the
  // back, turned sideways, not upright or tipped toward the lens is ignored
  // (see palm.ts). Turn off to accept a hand in any orientation.
  requirePalm: boolean;
  // With both hands in frame, let the cursor follow whichever one is moving
  // while the other rests (see handArbiter.ts). Off: the nominated primary
  // hand always drives when both are visible.
  autoHand: boolean;
  // Distance compensation: the active zone grows and shrinks with the hand's
  // apparent size, so the same arm movement moves the cursor the same distance
  // near the camera or far from it (see depthZone.ts). Off: the zone is fixed.
  depthZone: boolean;
  // The hand size (frame heights, see handScale) at which the zone keeps its
  // configured size. 0 learns it from the first second of tracking.
  depthRef: number;
  // Scale every hand-measured threshold (pinch on/off, the aim point's
  // freeze, the fast-motion pinch guard) with the hand's apparent size, so a
  // pinch takes the same physical finger gap near the camera or far from it
  // (see depthFactor in depthZone.ts). Off: thresholds are fixed frame units.
  depthThresholds: boolean;
}

// Defaults seeded from the desk-distance prototype (CPU, ~83ms infer, ~11px
// jitter, hand ~29% of frame). Conservative; the tweaking app refines them.
export const DEFAULT_PARAMS: PointerParams = {
  minCutoff: 1.0,
  beta: 0.02,
  zoneX0: 0.15,
  zoneY0: 0.15,
  zoneX1: 0.85,
  zoneY1: 0.85,
  deadzone: 3,
  maxInferenceFps: 15,
  // Tuned against the landmark overlay: 0.05 was loose enough that a pinch read
  // as closed before the fingers met, and 0.08 was far enough that releasing
  // needed an exaggerated opening. The remaining gap is the hysteresis that
  // stops a pinch flickering at the threshold; do not close it further.
  pinchOn: 0.04,
  pinchOff: 0.07,
  // Estimated, not measured: crossing the whole screen takes about 0.7 frame
  // heights, so this refuses a pinch only when the hand is on course to cross
  // it in under half a second.
  pinchMaxSpeed: 1.5,
  // Estimated from a simulated pinch, not measured on a camera. aimFreezeDist
  // sits just above pinchOff; it must stay below the gap of an open pointing
  // hand, or the finger offset never updates.
  aimTau: 0.15,
  aimFreezeDist: 0.09,
  aimFreezeRate: 0.25,
  aimHoldMs: 150,
  requirePalm: true,
  autoHand: true,
  depthZone: true,
  depthRef: 0,
  depthThresholds: true,
};

const KEY = "marbles.pointer.params";

export function loadParams(): PointerParams {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PARAMS };
    // Merge over defaults so a partial/old saved blob still yields every field.
    return { ...DEFAULT_PARAMS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export function saveParams(p: PointerParams): void {
  localStorage.setItem(KEY, JSON.stringify(p));
}

// Notify when another tab (the tweaking app) saves new params. Returns an
// unsubscribe. Only fires on cross-document writes, which is exactly the case.
export function subscribeParams(cb: (p: PointerParams) => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb(loadParams());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
