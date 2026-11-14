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

export { PinchGuard, nextPinch, PINCH_SETTLE } from "./pinchGuard";
export { AimPoint, type AimParams } from "./aimPoint";

export {
  HandRecorder,
  installHandRecorder,
  summarize,
  RECORDING_VERSION,
  DEFAULT_CAP,
  type HandRow,
  type HandRowInput,
  type RecordedHand,
  type HandMark,
  type RecordingDocument,
  type RecordingMeta,
  type RecordingSummary,
  type HandRecorderOptions,
  type InstallOptions,
  type HandRecorderConsole,
} from "./handRecorder";

export {
  HandArbiter,
  HandoffOffset,
  MotionTracker,
  PinchLatch,
  palmSpan,
  MOTION_TAU,
  MAX_GAP,
  MOVE,
  REST_RATIO,
  GAIN_MAX,
  EVIDENCE,
  LEAK,
  MIN_FRAMES,
  REFRACTORY,
  DRIVER_GRACE,
} from "./handArbiter";

export {
  handPose,
  poseUsable,
  palmFacing,
  fingersUp,
  palmLength,
  PALM_ON,
  PALM_OFF,
  UP_ON,
  UP_OFF,
  LEN_ON,
  LEN_OFF,
  type HandPose,
} from "./palm";

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
