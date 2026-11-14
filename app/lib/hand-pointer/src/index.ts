// Public surface. The layers, in pipeline order:
//
//   cameraPointer   camera + worker session; publishes hand state and status
//   cursorDriver    hand state -> cursor frame, pointer effects, actions (pure)
//   virtualPointer  sink: pointer effects -> synthetic DOM pointer events
//   actions         bus: semantic actions (zoom, pan) -> whichever surface claims
//   magnet          optional assist: the app registers a field of targets
//   mount           all of the above in one call, with a default cursor dot

export { startHandPointer, type HandPointerOptions } from "./mount";

export {
  cameraPointer,
  pointerStore,
  pointerTarget,
  secondaryHand,
  handDebug,
  clickSlop,
  GONE_MS,
  HAND_CLICK_SLOP_PX,
  DEFAULT_ASSETS,
  type PointerState,
  type PointerStatus,
  type PointerMode,
  type PriorityHand,
  type StartOptions,
} from "./cameraPointer";

export type { HandAssets, HandOut } from "./handWorker";
export type { Store } from "./store";

export {
  CursorDriver,
  DEFAULT_CURSOR_PARAMS,
  type CursorParams,
  type CursorFrame,
  type CursorDriverDeps,
  type HandState,
  type PointerSink,
} from "./cursorDriver";

export { VirtualPointer } from "./virtualPointer";

export { palmFacing, palmOpen, PALM_ON, PALM_OFF } from "./palm";

export {
  dispatchAction,
  registerActionHandler,
  PRIORITY,
  type Action,
  type ZoomAction,
  type PanAction,
} from "./actions";

export { setMagnetProvider, type MagnetTarget, type MagnetProvider } from "./magnet";

export {
  loadParams,
  saveParams,
  subscribeParams,
  DEFAULT_PARAMS,
  type PointerParams,
} from "./pointerParams";
