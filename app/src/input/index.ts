// The app's view of hand input. The pipeline itself (camera, landmarks, cursor
// driver, gestures) is the standalone library in lib/hand-pointer; this file
// re-exports it and adds the one React binding the app needs. Views import from
// here, never from the library directly, so the seam stays in one place.
import { useSyncExternalStore } from "react";
import { pointerStore, type PointerState } from "../../lib/hand-pointer/src";

export * from "../../lib/hand-pointer/src";
// The displayed dot, for hit-testing gesture targets after cursor smoothing.
export const handCursorPosition = { x: 0, y: 0 };

// React hook over the library's store. Selectors must return a primitive or a
// stable reference (every current one does), as with any external store.
// getState is attached for reads outside render (event handlers, the ticker).
export const usePointerStore = Object.assign(
  <T>(selector: (s: PointerState) => T): T =>
    useSyncExternalStore(pointerStore.subscribe, () => selector(pointerStore.getState())),
  { getState: pointerStore.getState },
);

// Reading surfaces ask for a steadier cursor (a wider deadzone against tremor).
// A drag wants the opposite: the window must follow the hand exactly. Holds are
// counted so overlapping surfaces compose, and a drag suspends them all.
import { cameraPointer as camera } from "../../lib/hand-pointer/src";
let steadyHolds = 0;
let dragging = false;
const applySteady = () => camera.setStabilize(steadyHolds > 0 && !dragging);
export const steady = {
  get dragging() { return dragging; },
  hold(): () => void {
    steadyHolds++; applySteady();
    let released = false;
    return () => { if (released) return; released = true; steadyHolds--; applySteady(); };
  },
  drag(on: boolean) { dragging = on; applySteady(); },
};
