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
  // Only use a hand held up with its palm facing the camera; one seen from the
  // back, turned sideways, not upright or tipped toward the lens is ignored
  // (see palm.ts). Turn off to accept a hand in any orientation.
  requirePalm: boolean;
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
  requirePalm: true,
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
