// Cursor magnet: a zoom-aware pull that snaps a jittery hand cursor onto graph
// nodes, so acquiring a small target no longer needs a steady hand. At low zoom
// a node is only a few px wide on screen and the camera cursor floats around it;
// the magnet grows a generous *screen-space* capture field (bigger where the
// node reads smaller) and eases the cursor into the node center.
//
// Separation of concerns: the graph owns the geometry (where each node sits on
// screen, how big it reads at the current zoom, and when the field is valid at
// all: occlusion, node-open state) and registers a provider; the hand cursor
// owns the feel (pull easing, speed fade, off-while-pinching) and calls
// queryMagnet each frame. Neither module imports the other. Only the hand
// cursor uses it: a real mouse needs no help and warping it feels wrong.

export interface MagnetTarget {
  id: string; // node id, so the cursor can stay locked across frames (hysteresis)
  x: number; // node center, viewport px
  y: number;
  capture: number; // screen radius at which the pull begins (0 at the edge)
  lock: number; // inner screen radius within which the pull is total (dot on center)
}

// (x, y): raw cursor in viewport px. preferId: the node the cursor is currently
// pulled toward, if any, so the provider can keep it sticky (a wider release
// radius) instead of flipping to a neighbor while the hand rests mid-hover.
export type MagnetProvider = (
  x: number,
  y: number,
  preferId: string | null,
) => MagnetTarget | null;

// Module-level singleton, like pointerTarget in cameraPointer: HMR would hot-swap
// this module and reset the provider to null while the graph's registration lives
// on in the old instance (magnet then silently does nothing). Force a full reload
// on edits so there is one registry.
if ((import.meta as { hot?: { decline(): void } }).hot) {
  (import.meta as { hot?: { decline(): void } }).hot!.decline();
}

let provider: MagnetProvider | null = null;

// One provider at a time (there is one graph). Register on mount, clear on unmount.
export function setMagnetProvider(p: MagnetProvider | null): void {
  provider = p;
}

export function queryMagnet(x: number, y: number, preferId: string | null): MagnetTarget | null {
  return provider ? provider(x, y, preferId) : null;
}

// Pull weight at screen distance d: 0 outside `capture`, ramping smoothly to 1
// at `lock`. Smoothstep so entering a field has no kick and the dot eases in.
// Also reused as a general down-ramp, e.g. fading the pull with cursor speed.
export function magnetPull(d: number, capture: number, lock: number): number {
  if (d <= lock) return 1;
  if (d >= capture) return 0;
  const t = (capture - d) / (capture - lock); // 1 at lock, 0 at capture
  return t * t * (3 - 2 * t);
}

// Shrink a 2D offset toward zero by `amount` (px), never past zero, direction
// preserved. Used during a pinch-drag: the continuity offset (magnet pull +
// pinch-dip anchor) drains in proportion to hand travel, so the drag blends
// back to exact 1:1 without the dot ever jumping.
export function drainOffset(x: number, y: number, amount: number): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (mag <= amount || mag === 0) return { x: 0, y: 0 };
  const s = (mag - amount) / mag;
  return { x: x * s, y: y * s };
}
