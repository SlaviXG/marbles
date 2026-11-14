// The app's view of hand input. The pipeline itself (camera, landmarks, cursor
// driver, gestures) is the standalone library in lib/hand-pointer; this file
// re-exports it and adds the one React binding the app needs. Views import from
// here, never from the library directly, so the seam stays in one place.
import { useSyncExternalStore } from "react";
import { pointerStore, type PointerState } from "../../lib/hand-pointer/src";

export * from "../../lib/hand-pointer/src";

// React hook over the library's store. Selectors must return a primitive or a
// stable reference (every current one does), as with any external store.
// getState is attached for reads outside render (event handlers, the ticker).
export const usePointerStore = Object.assign(
  <T>(selector: (s: PointerState) => T): T =>
    useSyncExternalStore(pointerStore.subscribe, () => selector(pointerStore.getState())),
  { getState: pointerStore.getState },
);
