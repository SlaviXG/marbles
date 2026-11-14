import { createStore } from "./store";
import { OneEuro } from "./oneEuro";
import { loadParams, subscribeParams, type PointerParams } from "./pointerParams";
import { createHandWorker, type HandAssets, type HandOut, type WorkerOut } from "./handWorker";
import { ArticulationTracker } from "./articulation";
import { handPose, keepHand, poseUsable, type HandPose } from "./palm";
import {
  DRIVER_GRACE,
  HandArbiter,
  HandoffOffset,
  MotionTracker,
  PinchLatch,
  palmSpan,
} from "./handArbiter";
import { PinchGuard, nextPinch } from "./pinchGuard";
import { AimPoint } from "./aimPoint";
import { DepthZone, SizeTracker, depthFactor, handScale, type Zone } from "./depthZone";
import { dedupeHands } from "./dedupeHands";
import { HandRecorder, installHandRecorder } from "./handRecorder";
import { DEFAULT_CURSOR_PARAMS } from "./cursorDriver";

// The camera pointer: webcam -> worker (hand landmarks) -> One Euro filter ->
// screen mapping. It writes the latest screen-space hand state to plain
// singletons (read by the cursor every frame, so a 60fps render never goes
// through a UI framework) and publishes coarse status to a small store
// (off/starting/tracking/...).
//
// It is one of two pointer sources behind a narrow contract (a moving
// { x, y, present, pinching } target). The real mouse is the other, and exactly
// one owns the cursor at a time (see PointerMode).

export type PointerStatus = "off" | "starting" | "tracking" | "denied" | "error";
// Which source currently owns the cursor. Exactly one is active, so there are
// never two cursors: mouse mode shows the native cursor and stands the hand down;
// hand mode hides the native cursor and drives the synthetic (virtual) pointer.
export type PointerMode = "hand" | "mouse";
// Which hand drives the cursor when both are in frame. Handedness is a stable
// user trait, so it persists; the other hand is still tracked and takes over
// whenever the primary one is out of frame.
export type PriorityHand = "L" | "R";

const PRIORITY_KEY = "marbles.pointer.priorityHand";

const loadPriority = (): PriorityHand => {
  try {
    return localStorage.getItem(PRIORITY_KEY) === "L" ? "L" : "R";
  } catch {
    return "R";
  }
};

export interface PointerState {
  status: PointerStatus;
  error: string | null;
  mode: PointerMode;
  priority: PriorityHand;
  debug: boolean;
  set: (status: PointerStatus, error?: string | null) => void;
  setMode: (mode: PointerMode) => void;
  setPriority: (hand: PriorityHand) => void;
  toggleDebug: () => void;
}

export const pointerStore = createStore<PointerState>((set, get) => ({
  status: "off",
  error: null,
  mode: "hand",
  priority: loadPriority(),
  debug: false,
  toggleDebug: () => set({ debug: !get().debug }),
  set: (status, error = null) => set({ status, error }),
  setMode: (mode) => set({ mode }),
  setPriority: (priority) => {
    try {
      localStorage.setItem(PRIORITY_KEY, priority);
    } catch {
      /* private mode: keep it for this session only */
    }
    set({ priority });
  },
}));

// This module owns long-lived singletons: the camera session and the shared
// pointerTarget the cursor reads. HMR would hot-swap it, splitting the running
// session from the React tree's fresh import (the cursor then reads a stale
// target stuck at 0,0). Force a full reload on edits so there is one instance.
if ((import.meta as { hot?: { decline(): void } }).hot) {
  (import.meta as { hot?: { decline(): void } }).hot!.decline();
}

// Screen-space target the cursor chases. Mutated here, read in the ticker.
// `pinching` (thumb + index) is the one press gesture: held it drags and
// scrolls, released without travel it clicks, and on both hands it zooms.
export const pointerTarget = {
  x: 0,
  y: 0,
  present: false,
  pinching: false,
  lastSeen: 0,
};

// The other hand, when both are in frame. It drives no cursor of its own (there
// is only ever one cursor); it exists so two-handed gestures can be recognised,
// starting with pinch-to-zoom. Same screen space as pointerTarget, but with no
// deadzone: a zoom reads the distance between hands, where a few px of tremor is
// noise the gesture already tolerates, and freezing it would stall the zoom.
export const secondaryHand = {
  x: 0,
  y: 0,
  present: false,
  pinching: false,
  lastSeen: 0,
};

// Raw landmarks for the debug overlay, in normalized frame coords (NOT screen
// space): the overlay draws camera space on purpose, so it can show the active
// zone and whether a hand has drifted outside it. `version` ticks on every
// inference result so the renderer can skip redraws between them.
export const handDebug = {
  // `pose` holds the pose measurements (see palm.ts) and `active` whether the
  // hand passed the pose gate and is being used as input. Hands that fail it
  // are still listed, so the overlay can show a hand that is seen but ignored.
  hands: [] as { hand: "L" | "R"; pts: number[]; primary: boolean; pose: HandPose; active: boolean }[],
  version: 0,
  // Live tap-gesture state for the overlay, so a click that does not fire can be
  // told apart from a gesture that was never recognised.
  // Smoothed shape velocity per hand, keyed by handedness. Displayed only for
  // now: the arbiter that would use it is not wired up until the numbers show
  // the two hands actually separate during real use.
  articulation: { L: 0, R: 0 } as Record<"L" | "R", number>,
  // How far each hand's index knuckle is from where it recently was, in palm
  // lengths (see MotionTracker in handArbiter.ts): the signal that decides
  // which hand drives when both are in frame.
  motion: { L: 0, R: 0 } as Record<"L" | "R", number>,
  // Hands moving too fast to start a pinch right now (see pinchGuard.ts).
  fast: { L: false, R: false } as Record<"L" | "R", boolean>,
  // What the arbiter is doing about a handover (see HandArbiter.why). Empty
  // when there is nothing to decide.
  arbiter: "",
  // The active zone in use (mirrored normalized frame coords), and how it is
  // scaled for the hand's distance (see depthZone.ts). ratio 1 = configured.
  zone: null as Zone | null,
  depth: { scale: 0, ref: 0, ratio: 1 },
  // Per hand: how much its thresholds are scaled for its distance (see
  // depthFactor), and its thumb-index gap after that scaling, which is the
  // number the pinch thresholds actually compare against.
  factor: { L: 1, R: 1 } as Record<"L" | "R", number>,
  gap: { L: 0, R: 0 } as Record<"L" | "R", number>,
  // Progress toward a handover, 0..1 (see HandArbiter.evidence).
  evidence: 0,
};

const DOWNSCALE = 256; // cap the frame's long side before inference (cheap win)
// How far (screen px) the hand must move from where it sat when the mouse took
// over before it reclaims the cursor. High enough to require intent, not tremor.
const HAND_RECLAIM_PX = 90;
// Hand considered absent once unseen for this long. Shared truth: the producer
// holds presence/pinch through this grace on missed detections, the consumer
// (the cursor driver) hides the cursor past it, so the value lives with the
// driver's params and is read from there.
export const GONE_MS = DEFAULT_CURSOR_PARAMS.goneMs;

// How far the pointer may wander between press and release and still count as a
// click rather than a drag, when a hand is driving.
//
// A mouse holds within a few px, so views set thresholds around 4-6. A hand
// cannot: resting jitter is ~10px, and the index tip physically dips toward the
// thumb as a pinch closes, which moves the pointer during the very gesture that
// is supposed to be a click. Under a mouse-sized threshold every pinch-click
// registers as a drag and the click is swallowed, which is exactly the "clicking
// a node does nothing" symptom.
export const HAND_CLICK_SLOP_PX = 30;

// Views pass their own mouse-sized threshold and get a floor while the hand is
// driving, so mouse precision is untouched and only the hand path is loosened.
export function clickSlop(mousePx: number): number {
  return pointerStore.getState().mode === "hand"
    ? Math.max(mousePx, HAND_CLICK_SLOP_PX)
    : mousePx;
}

// MediaPipe's runtime and model. Defaults load from public CDNs; pass your own
// URLs (relative ones resolve against the page) to serve them locally, which is
// worth doing wherever the network cannot be trusted.
const MEDIAPIPE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
export const DEFAULT_ASSETS: HandAssets = {
  visionUrl: `${MEDIAPIPE}/vision_bundle.mjs`,
  wasmUrl: `${MEDIAPIPE}/wasm`,
  modelUrl:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
};

export interface StartOptions {
  assets?: Partial<HandAssets>;
}

// The worker runs from a Blob and has no base URL, so everything is made
// absolute here, against the page.
function resolveAssets(over: Partial<HandAssets> = {}): HandAssets {
  const abs = (u: string) => new URL(u, document.baseURI).href;
  const a = { ...DEFAULT_ASSETS, ...over };
  return { visionUrl: abs(a.visionUrl), wasmUrl: abs(a.wasmUrl), modelUrl: abs(a.modelUrl) };
}

// Visit /?debug for the per-second heartbeat and the worker's first-frame timing.
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");

class CameraPointer {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private worker: Worker | null = null;
  private params: PointerParams = loadParams();
  // The active zone, resized for the driving hand's distance from the camera.
  private depth = new DepthZone(zoneOf(this.params));
  // Per physical hand: smoothed apparent size, for scaling its thresholds.
  private size: Record<"L" | "R", SizeTracker> = { L: new SizeTracker(), R: new SizeTracker() };
  private fx = new OneEuro(this.params.minCutoff, this.params.beta);
  private fy = new OneEuro(this.params.minCutoff, this.params.beta);
  // The second hand needs its own filter pair: sharing one would blend two
  // different hands' histories and yank both positions whenever either moves.
  private fx2 = new OneEuro(this.params.minCutoff, this.params.beta);
  private fy2 = new OneEuro(this.params.minCutoff, this.params.beta);
  // Per-handedness, not per-role: the tracker must follow the physical hand, so
  // that swapping which one drives the cursor does not swap their histories.
  private artic: Record<"L" | "R", ArticulationTracker> = {
    L: new ArticulationTracker(),
    R: new ArticulationTracker(),
  };
  // Whether each physical hand currently passes the pose gate. Kept between
  // frames for the hysteresis in poseUsable.
  private palm: Record<"L" | "R", boolean> = { L: false, R: false };
  // Which hand drives when both are in frame: the one that is moving while
  // the other rests. Motion is tracked per physical hand, like articulation.
  private motion: Record<"L" | "R", MotionTracker> = {
    L: new MotionTracker(),
    R: new MotionTracker(),
  };
  private arbiter = new HandArbiter();
  // When each physical hand was last in frame and usable (seconds, on the
  // frame clock). A hand's per-hand state below survives a miss shorter than
  // DRIVER_GRACE, so a single dropped detection does not restart it.
  private seenT: Record<"L" | "R", number> = { L: NaN, R: NaN };
  // Whether each physical hand is pinching. Per hand, not per role: when the
  // cursor changes hands, each hand keeps its own pinch.
  private pinch: Record<"L" | "R", boolean> = { L: false, R: false };
  // Keeps a hand that takes the cursor over from pressing with it until it
  // has been seen open (see PinchLatch).
  private pinchLatch = new PinchLatch();
  // Per physical hand: refuses a pinch that starts mid-sweep (motion blur).
  private guard: Record<"L" | "R", PinchGuard> = { L: new PinchGuard(), R: new PinchGuard() };
  // Per physical hand: the point the hand aims at, steady through a pinch.
  private aim: Record<"L" | "R", AimPoint> = { L: new AimPoint(), R: new AimPoint() };
  // The hand that drove the cursor on the last frame, to notice a handover.
  private driving: "L" | "R" | null = null;
  // Carries the cursor's position across a handover so it does not jump.
  private handoff = new HandoffOffset();
  // Camera frame width / height, so pose angles are measured in real
  // proportions rather than the stretched normalized ones.
  private aspect = 4 / 3;
  private busy = false; // worker has a frame in flight (backpressure)
  private lastSent = 0;
  private rafId = 0;
  private unsubParams: (() => void) | null = null;
  private canvas: OffscreenCanvas | null = null;
  private cctx: OffscreenCanvasRenderingContext2D | null = null;
  // Arbiter: where the hand was when the mouse took over, so a deliberate hand
  // move past a threshold reclaims hand mode. And a stabilize flag (set while a
  // node is open) that widens the deadzone so the cursor holds still for reading.
  private handAnchor = { x: 0, y: 0 };
  private stabilize = false;
  // Last real pointer position, so a "moved" pointermove can be told apart from
  // one WebKit synthesizes (trusted, but at an unchanged position) to recompute
  // :hover/hit-testing when content scrolls under a stationary OS pointer, e.g.
  // during a hand-driven drag-scroll. Only actual motion should take the cursor.
  private lastRealPos: { x: number; y: number } | null = null;
  // diagnostics: counts since the last heartbeat log (per second)
  private dbg = { sent: 0, tips: 0, hands: 0, bmpErr: 0, stall: 0 };
  private dbgTimer = 0;
  // Debug recorder (see handRecorder.ts and RECORDING.md). Null unless ?debug,
  // so a normal session pays one null check per frame and nothing else. Kept
  // across stop/start so turning the hand cursor off does not lose a take.
  private rec: HandRecorder | null = null;
  private uninstallRec: (() => void) | null = null;

  async start(options: StartOptions = {}) {
    if (this.stream) return;
    pointerStore.getState().set("starting");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
    } catch (e) {
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      console.error("[hand cursor] getUserMedia failed:", e);
      pointerStore.getState().set(denied ? "denied" : "error", String(e));
      return;
    }

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.stream;
    // Keep it in the DOM but off-screen: a detached/display:none video may stop
    // decoding fresh frames in Chrome (the cause of the stuck frame pump).
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:160px;height:120px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    await video.play();
    this.video = video;

    // A classic worker started from a Blob (see handWorker.ts for why).
    this.worker = createHandWorker();
    this.worker.onmessage = (ev) => this.onResult(ev.data);
    // Uncaught errors inside the worker (e.g. module load / wasm fetch) do not
    // arrive via onmessage; capture them here so they are visible, not silent.
    this.worker.onerror = (e) => {
      const message = e.message || "worker error";
      console.error("[hand cursor] worker error:", e);
      pointerStore.getState().set("error", message);
    };
    this.worker.postMessage({ type: "init", assets: resolveAssets(options.assets), trace: DEBUG });

    // Live-apply params saved by the tweaking app (another tab).
    this.unsubParams = subscribeParams((p) => this.applyParams(p));

    // Start in hand mode; a real mouse will take over on its first move.
    pointerStore.getState().setMode("hand");
    this.lastRealPos = null;
    window.addEventListener("pointermove", this.onRealPointer, true);
    window.addEventListener("pointerdown", this.onRealPointer, true);

    // Heartbeat under ?debug: one line/sec, to see which stage stalls.
    if (DEBUG) {
      this.rec ??= new HandRecorder({
        meta: () => ({
          userAgent: navigator.userAgent,
          frame: { width: this.video?.videoWidth ?? 0, height: this.video?.videoHeight ?? 0 },
          params: this.params,
        }),
      });
      this.uninstallRec = installHandRecorder(this.rec);
      this.dbgTimer = window.setInterval(() => {
        const d = this.dbg;
        console.log(
          `[hand cursor] sent=${d.sent} tips=${d.tips} hands=${d.hands} bmpErr=${d.bmpErr} stall=${d.stall} present=${pointerTarget.present} xy=${pointerTarget.x.toFixed(0)},${pointerTarget.y.toFixed(0)} pinch=${pointerTarget.pinching} vid=${this.video?.videoWidth}x${this.video?.videoHeight}`,
        );
        this.dbg = { sent: 0, tips: 0, hands: 0, bmpErr: 0, stall: 0 };
      }, 1000);
    }

    this.pump();
  }

  stop() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    clearInterval(this.dbgTimer);
    this.dbgTimer = 0;
    this.uninstallRec?.();
    this.uninstallRec = null;
    window.removeEventListener("pointermove", this.onRealPointer, true);
    window.removeEventListener("pointerdown", this.onRealPointer, true);
    pointerStore.getState().setMode("hand");
    this.unsubParams?.();
    this.unsubParams = null;
    this.worker?.terminate();
    this.worker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video?.remove();
    this.video = null;
    this.canvas = null;
    this.cctx = null;
    this.busy = false;
    this.arbiter.reset();
    this.motion.L.reset();
    this.motion.R.reset();
    this.seenT = { L: NaN, R: NaN };
    this.pinch = { L: false, R: false };
    this.pinchLatch.reset();
    this.driving = null;
    this.handoff.clear();
    this.aim.L.reset();
    this.aim.R.reset();
    this.guard.L.reset();
    this.guard.R.reset();
    this.depth.reset();
    this.size.L.reset();
    this.size.R.reset();
    pointerTarget.present = false;
    pointerStore.getState().set("off");
  }

  private applyParams(p: PointerParams) {
    this.params = p;
    this.depth.setHome(zoneOf(p));
    this.fx = new OneEuro(p.minCutoff, p.beta);
    this.fy = new OneEuro(p.minCutoff, p.beta);
    this.fx2 = new OneEuro(p.minCutoff, p.beta);
    this.fy2 = new OneEuro(p.minCutoff, p.beta);
  }

  // Normalized frame coords -> screen px. The mirror (front camera) and the
  // active-zone mapping are the same for either hand, so both go through here.
  private toScreen(nx: number, ny: number) {
    const p = this.params;
    if (p.depthZone) {
      const m = this.depth.map(nx, ny);
      return { x: m.u * window.innerWidth, y: m.v * window.innerHeight };
    }
    const u = clamp01((nx - p.zoneX0) / (p.zoneX1 - p.zoneX0));
    const v = clamp01((ny - p.zoneY0) / (p.zoneY1 - p.zoneY0));
    return { x: u * window.innerWidth, y: v * window.innerHeight };
  }

  // A real mouse/touchpad moved (trusted: our synthetic events are not, so no
  // feedback). Hand the cursor to the mouse and remember where the hand was, so a
  // later deliberate hand move can reclaim it.
  private onRealPointer = (e: PointerEvent) => {
    if (!e.isTrusted) return;
    const last = this.lastRealPos;
    if (e.type === "pointermove") {
      this.lastRealPos = { x: e.clientX, y: e.clientY };
      // A move that reports the same position as last time is not motion (it is
      // WebKit's synthetic re-hover, fired at the pointer's last real spot when
      // content moves underneath it, not the user grabbing the mouse).
      if (last && last.x === e.clientX && last.y === e.clientY) return;
    } else {
      this.lastRealPos = { x: e.clientX, y: e.clientY };
    }
    if (pointerStore.getState().mode !== "mouse") {
      this.handAnchor = { x: pointerTarget.x, y: pointerTarget.y };
      pointerStore.getState().setMode("mouse");
    }
  };

  // Called while a node is open: widen the deadzone so the cursor holds still for
  // reading instead of drifting with hand tremor (amplified by the active zone).
  setStabilize(on: boolean) {
    this.stabilize = on;
  }

  // Frame pump: hand the worker a downscaled bitmap, but only when it is idle and
  // not above the inference-rate cap. Dropped frames are fine; freshest wins.
  private pump = () => {
    const video = this.video;
    if (!video) return;
    const minGap = 1000 / this.params.maxInferenceFps;
    const now = performance.now();
    // Watchdog: if a sent frame has not been answered in 1.5s the worker is
    // wedged on it (e.g. a hung inference); drop it so the pump can recover.
    if (this.busy && now - this.lastSent > 1500) {
      this.busy = false;
      this.dbg.stall++;
    }
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!this.busy && now - this.lastSent >= minGap && video.readyState >= 2 && vw > 0 && vh > 0) {
      this.lastSent = now;
      this.aspect = vw / vh;
      // Downscale only when larger than the target. Snapshot the frame onto an
      // OffscreenCanvas and transfer it: transferToImageBitmap is synchronous and
      // reliable, unlike createImageBitmap(video) which can hang on some setups.
      const long = Math.max(vw, vh);
      const scale = long > DOWNSCALE ? DOWNSCALE / long : 1;
      const dw = Math.round(vw * scale);
      const dh = Math.round(vh * scale);
      if (!this.canvas || this.canvas.width !== dw || this.canvas.height !== dh) {
        this.canvas = new OffscreenCanvas(dw, dh);
        this.cctx = this.canvas.getContext("2d");
      }
      if (this.cctx && this.worker) {
        try {
          this.cctx.drawImage(video, 0, 0, dw, dh);
          const bitmap = this.canvas.transferToImageBitmap();
          this.busy = true;
          this.dbg.sent++;
          this.worker.postMessage({ type: "frame", bitmap, t: now }, [bitmap]);
        } catch (e) {
          this.dbg.bmpErr++;
          if (this.dbg.bmpErr === 1) console.error("[hand cursor] frame snapshot failed:", e);
        }
      }
    }
    this.rafId = requestAnimationFrame(this.pump);
  };

  // Debug recording of one result frame. Only called when this.rec exists.
  // Every raw hand is recorded, including ones the pose gate rejected, so a
  // recording can be replayed through the pure logic with different constants.
  private record(
    msg: { hands: HandOut[]; t: number },
    pose: Map<HandOut, HandPose>,
    active: HandOut[],
    driver: "L" | "R" | null,
    motion: Partial<Record<"L" | "R", number>>,
    extra?: Record<string, unknown>,
  ) {
    this.rec!.push({
      t: msg.t,
      at: performance.now(),
      hands: msg.hands.map((c) => ({
        hand: c.hand,
        conf: c.conf,
        pts: c.pts,
        pose: pose.get(c),
        active: active.includes(c),
      })),
      driver,
      why: handDebug.arbiter,
      motion,
      evidence: handDebug.evidence,
      primaryPinching: pointerTarget.pinching,
      secondaryPinching: secondaryHand.pinching,
      fast: handDebug.fast,
      mode: pointerStore.getState().mode,
      extra,
    });
  }

  private onResult(msg: WorkerOut) {
    if (msg.type === "ready") {
      pointerStore.getState().set("tracking");
      return;
    }
    if (msg.type === "error") {
      console.error("[hand cursor]", msg.message);
      // A per-frame inference error should not tear down tracking; only a failure
      // before we ever started tracking is fatal.
      if (pointerStore.getState().status !== "tracking") {
        pointerStore.getState().set("error", msg.message);
      }
      this.busy = false;
      return;
    }
    // a result arrived: the worker is free for the next frame
    this.busy = false;
    this.dbg.tips++;
    // Pose gate: only a hand held up with its palm to the camera is input. One
    // seen from the back, turned sideways, lying level, hanging down or tipped
    // so the fingers point at the lens is dropped here, before any gesture is
    // read from it, and from then on is treated like a hand not in frame.
    //
    // First, one hand reported twice is merged into one (see dedupeHands.ts):
    // a duplicate would otherwise act as a second hand that pinches whenever
    // the real one does, and a one-handed pinch would zoom the canvas.
    const detected = dedupeHands(msg.hands, this.aspect, this.driving);
    for (const side of ["L", "R"] as const) {
      if (!detected.some((c) => c.hand === side)) this.palm[side] = false;
    }
    const pose = new Map<HandOut, HandPose>();
    for (const c of msg.hands) if (!detected.includes(c)) pose.set(c, handPose(c.pts, c.hand, this.aspect));
    const hands = detected.filter((c) => {
      const s = handPose(c.pts, c.hand, this.aspect);
      pose.set(c, s);
      this.palm[c.hand] = poseUsable(s, this.palm[c.hand]);
      // A pinching hand is never dropped for its pose, single pinch or
      // two-hand: see keepHand. this.pinch is the hand's own pinch, held
      // through brief tracking losses, as of the previous frame.
      return keepHand(this.palm[c.hand], this.pinch[c.hand], this.params.requirePalm);
    });

    const p = this.params;
    const t = msg.t / 1000;

    // Everything kept per physical hand: motion (for the arbiter), the pinch
    // guard, the pinch itself. Measured for each usable hand whatever its
    // role turns out to be this frame.
    //
    // A hand that is missing keeps its state for DRIVER_GRACE. Single missed
    // detections are common, and restarting a hand's trackers on each one
    // would make it read as freshly arrived (motion zero, pinch released,
    // aim offset forgotten) every time. Only a hand gone that long is reset,
    // so that its return is not read as a move or a sweep.
    //
    // Motion is measured at the index knuckle (landmark 5), not the
    // fingertip: closing a pinch moves the fingertip, and a resting hand that
    // pinches must not read as a hand that is pointing and take the cursor.
    const motion: Partial<Record<"L" | "R", number>> = {};
    const reversal: Partial<Record<"L" | "R", boolean>> = {};
    // Thumb tip to index tip distance in normalized space: what the pinch
    // thresholds on.
    const gap: Partial<Record<"L" | "R", number>> = {};
    for (const side of ["L", "R"] as const) {
      const seen = hands.find((c) => c.hand === side);
      if (seen) {
        this.seenT[side] = t;
        const tracker = this.motion[side];
        motion[side] = tracker.update(
          seen.pts[10] * this.aspect,
          seen.pts[11],
          palmSpan(seen.pts, this.aspect),
          t,
        );
        reversal[side] = tracker.reversal;
        // Distance scaling for this hand's thresholds. Every threshold below
        // is a physical size or speed expressed in frame units, and the image
        // shrinks both the hand and its gaps with distance by the same factor,
        // so dividing the measurement by the hand's apparent size (relative
        // to the reference) makes the thresholds hold at any distance. A
        // hand twice as close needs a gap twice as wide in the image for the
        // same physical pinch: the threshold scales WITH apparent size.
        const k = p.depthThresholds
          ? depthFactor(this.size[side].update(handScale(seen.pts, this.aspect), t), this.depth.ref)
          : 1;
        handDebug.factor[side] = k;
        // Palm speed from the middle knuckle (landmark 9), which survives
        // blur and does not move when the fingers close.
        handDebug.fast[side] = this.guard[side].update(
          seen.pts[18] * this.aspect,
          seen.pts[19],
          t,
          p.pinchMaxSpeed * k,
        );
        // Pinch, with hysteresis so a click does not flicker at the
        // threshold. It may not START while the hand is sweeping fast: blur
        // makes the fingertips read as touching (see pinchGuard.ts). The gap
        // is in reference-hand units, so it serves the pinch, the pinch latch
        // and the aim point's freeze alike.
        const d = Math.hypot(seen.x - seen.thumbX, seen.y - seen.thumbY) / k;
        gap[side] = d;
        handDebug.gap[side] = d;
        this.pinch[side] = nextPinch(
          this.pinch[side],
          d,
          p.pinchOn,
          p.pinchOff,
          handDebug.fast[side],
        );
      } else if (!(t - this.seenT[side] < DRIVER_GRACE)) {
        this.motion[side].reset();
        this.guard[side].reset();
        this.aim[side].reset();
        this.size[side].reset();
        this.pinch[side] = false;
        handDebug.fast[side] = false;
        handDebug.factor[side] = 1;
      }
      handDebug.motion[side] = motion[side] ?? 0;
    }

    if (hands.length === 0) {
      // A missed detection is not a missing hand: a pinched hand occludes its
      // own landmarks, so single misses are common exactly mid-drag. Hold
      // presence and pinch through the GONE_MS grace (lastSeen ages naturally)
      // instead of releasing a pinch-drag on one dropped frame.
      if (performance.now() - pointerTarget.lastSeen > GONE_MS) {
        pointerTarget.present = false;
        pointerTarget.pinching = false;
      }
      if (performance.now() - secondaryHand.lastSeen > GONE_MS) {
        secondaryHand.present = false;
        secondaryHand.pinching = false;
      }
      handDebug.hands = msg.hands.map((c) => ({
        hand: c.hand,
        pts: c.pts,
        primary: false,
        pose: pose.get(c)!,
        active: false,
      }));
      handDebug.version++;
      this.artic.L.reset();
      this.artic.R.reset();
      handDebug.articulation.L = 0;
      handDebug.articulation.R = 0;
      handDebug.arbiter = "";
      handDebug.evidence = 0;
      if (this.rec) this.record(msg, pose, hands, null, {});
      return;
    }
    this.dbg.hands++;
    const now = performance.now();

    // The hand that was driving is not in this frame. Its pinch and presence
    // are held, exactly as when no hand is seen at all, and end the same way:
    // once it has been unseen for GONE_MS. Done before asking the arbiter,
    // because the arbiter never takes the cursor from a pinching hand, and
    // this is what tells it the pinch is over.
    if (
      this.driving !== null &&
      !hands.some((c) => c.hand === this.driving) &&
      now - pointerTarget.lastSeen > GONE_MS
    ) {
      pointerTarget.present = false;
      pointerTarget.pinching = false;
    }

    // Pick the hand that drives. With one hand raised it is that hand,
    // whichever it is. With both, the arbiter follows the one that is moving
    // while the other rests (see handArbiter.ts); the user's nominated hand is
    // the starting choice, and the only choice when autoHand is off.
    const want = pointerStore.getState().priority;
    // Locked while the driving hand's press is down (a click or drag in
    // progress), and while BOTH hands are pinching: that is a two-hand zoom or
    // pan, in which one hand often holds still while the other moves, exactly
    // the pattern a takeover looks for. Both are read from the physical pinch
    // of each hand, so a press held back by the pinch latch, or a zoom the
    // driver has not yet registered as a press, still locks. Each hand's pinch
    // is held through its grace period, so a hand lost for a frame mid-zoom
    // keeps the lock. The other hand pinching on its own does not lock: a
    // relaxed hand often rests with thumb and finger close enough to read as
    // one, and that must not stop it taking the cursor.
    const bothPinching = this.pinch.L && this.pinch.R;
    const pick = p.autoHand
      ? this.arbiter.update(motion, reversal, pointerTarget.pinching || bothPinching, want, t)
      : want;
    handDebug.arbiter = p.autoHand ? this.arbiter.why : "";
    handDebug.evidence = p.autoHand ? this.arbiter.evidence : 0;
    const picked = hands.find((c) => c.hand === pick);
    // Held: the arbiter is keeping the cursor with a hand that is missing
    // from this frame (see DRIVER_GRACE). Nobody drives this frame. The hand
    // that IS visible must not stand in for it, which would be the very
    // handover the grace exists to prevent; it stays the secondary hand.
    // With autoHand off there is no grace: the nominated hand drives if it is
    // here, and otherwise whichever hand is.
    const held = p.autoHand && !picked;
    const h = held ? null : (picked ?? hands[0]);

    // Handover: the filters hold each hand's own history, so they follow the
    // hands rather than the roles. Without this the new driver would be
    // smoothed from the old one's position and glide across the screen.
    const handover = h !== null && this.driving !== null && this.driving !== h.hand;
    if (handover) {
      [this.fx, this.fx2] = [this.fx2, this.fx];
      [this.fy, this.fy2] = [this.fy2, this.fy];
    }
    if (h) this.driving = h.hand;

    handDebug.hands = msg.hands.map((c) => ({
      hand: c.hand,
      pts: c.pts,
      primary: c === h,
      pose: pose.get(c)!,
      active: hands.includes(c),
    }));
    handDebug.version++;

    // Articulation per physical hand, and reset for whichever hand is absent so
    // a hand that leaves and returns does not read its re-entry as a gesture.
    for (const side of ["L", "R"] as const) {
      const seen = hands.find((c) => c.hand === side);
      if (seen) handDebug.articulation[side] = this.artic[side].update(seen.pts, t);
      else {
        this.artic[side].reset();
        handDebug.articulation[side] = 0;
      }
    }

    // The other hand, if there is one. Tracked for two-handed gestures only.
    // It must carry the other label: all per-hand state (pinch, aim, filters)
    // is keyed by label, so a second detection labelled like the driver would
    // read the DRIVER's pinch and turn every pinch into a two-hand pinch. Two
    // real hands with one label is a tracker mistake; that frame simply has
    // no second hand.
    const o = hands.find((c) => c !== h && (h === null || c.hand !== h.hand));
    if (o) {
      secondaryHand.pinching = this.pinch[o.hand];
      const oa = this.aim[o.hand].update(o.pts, gap[o.hand]!, this.pinch[o.hand], t, p);
      const s = this.toScreen(this.fx2.filter(1 - oa.x, t), this.fy2.filter(oa.y, t));
      secondaryHand.x = s.x;
      secondaryHand.y = s.y;
      secondaryHand.present = true;
      secondaryHand.lastSeen = now;
    } else if (now - secondaryHand.lastSeen > GONE_MS) {
      secondaryHand.present = false;
      secondaryHand.pinching = false;
    }

    if (!h) {
      // Held frame: the cursor stays where it is, with the press it had.
      //
      // Not pinching, the cursor is also kept alive (lastSeen refreshed). The
      // cursor driver hides a cursor unseen for GONE_MS, and DRIVER_GRACE is
      // the same 250 ms, but the two cannot line up: the grace ends on the
      // first FRAME past 250 ms, which is processed up to a frame interval
      // after the cursor would already have been hidden. Left to age, the
      // cursor would blink off for that interval and then reappear under the
      // other hand. Here that cannot strand a cursor: the arbiter ends an
      // unpinched hold within DRIVER_GRACE, by the driver returning or by the
      // visible hand taking over, and either way the cursor carries on.
      //
      // Pinching, lastSeen is left to age instead, so a press whose hand has
      // gone is released after GONE_MS just as it is with no hand in frame
      // (the check above then lifts the arbiter's lock).
      if (pointerTarget.present && !pointerTarget.pinching) pointerTarget.lastSeen = now;
      if (this.rec) this.record(msg, pose, hands, pick ?? null, motion, { held: true });
      return;
    }

    // The press follows the physical hand: this hand's own pinch, except that
    // a hand which has just taken the cursor over cannot press until it has
    // been seen open (see PinchLatch). That holds even if the cursor had
    // already gone when it took over: a drag whose hand left the frame must
    // not resume under a second hand that happens to rest half-closed.
    const pinchDist = gap[h.hand]!;
    pointerTarget.pinching = this.pinchLatch.update(
      handover,
      this.pinch[h.hand],
      pinchDist,
      p.pinchOff,
    );

    // Where the hand aims: the fingertip while it is open, held steady through
    // a pinch so the click lands where it was aimed (see aimPoint.ts). It is
    // told about the hand's physical pinch, latched or not: what it guards
    // against is the finger curling, whether or not that is a press.
    const ha = this.aim[h.hand].update(h.pts, pinchDist, this.pinch[h.hand], t, p);
    // mirror x (front camera), de-jitter in normalized space, then active zone
    // -> full screen (same mapping the second hand goes through). The zone is
    // first resized for this hand's distance, about the point it aims at, so
    // leaning in or out never moves the cursor (see depthZone.ts). A cursor
    // that had gone starts again from the configured zone.
    const fnx = this.fx.filter(1 - ha.x, t);
    const fny = this.fy.filter(ha.y, t);
    // Always updated, even with the zone fixed: it also learns the reference
    // size the thresholds are scaled against.
    if (!pointerTarget.present) this.depth.release();
    this.depth.update(fnx, fny, handScale(h.pts, this.aspect), t, p.depthRef);
    handDebug.zone = p.depthZone ? this.depth.zone : null;
    handDebug.depth.scale = this.depth.scale;
    handDebug.depth.ref = this.depth.ref;
    handDebug.depth.ratio = p.depthZone ? this.depth.ratio : 1;
    const raw = this.toScreen(fnx, fny);
    pointerTarget.lastSeen = now;

    // A different hand took over: it picks the cursor up from where it stands
    // rather than pulling it to its own position (see HandoffOffset). With no
    // cursor on screen there is nothing to carry over, so start clean.
    if (!pointerTarget.present) this.handoff.clear();
    else if (handover) this.handoff.begin(pointerTarget.x, pointerTarget.y, raw.x, raw.y);
    const aim = this.handoff.apply(raw.x, raw.y, DEFAULT_CURSOR_PARAMS.offsetRecycle);
    const x = Math.min(window.innerWidth, Math.max(0, aim.x));
    const y = Math.min(window.innerHeight, Math.max(0, aim.y));

    // Reclaim: while the mouse owns the cursor, a deliberate hand move (well past
    // where the hand sat when the mouse took over) hands control back to the hand.
    if (pointerStore.getState().mode === "mouse") {
      if (Math.hypot(x - this.handAnchor.x, y - this.handAnchor.y) > HAND_RECLAIM_PX) {
        pointerStore.getState().setMode("hand");
      }
    }

    // Deadzone: ignore sub-threshold drift so a held hand stays put. Widened while
    // stabilizing (a node is open) so reading is not disturbed by hand tremor.
    // Soft (radial): once tremor crosses the threshold, carry only the excess
    // past it rather than snapping the anchor onto the raw (still noisy) sample.
    // A hard hold-then-jump reads as a twitch every time tremor happens to cross
    // the line; easing in the excess keeps the anchor continuous through it.
    if (this.rec) {
      this.record(msg, pose, hands, h.hand, motion, {
        pinchDist,
        handover,
        x,
        y,
        rawX: raw.x,
        rawY: raw.y,
        aimFrozen: this.aim[h.hand].frozen,
        handScale: this.depth.scale,
        zoneRatio: handDebug.depth.ratio,
        factor: { ...handDebug.factor },
      });
    }

    const dz = this.stabilize ? p.deadzone * 6 : p.deadzone;
    if (pointerTarget.present) {
      const ddx = x - pointerTarget.x;
      const ddy = y - pointerTarget.y;
      const dist = Math.hypot(ddx, ddy);
      if (dist < dz) return;
      const k = (dist - dz) / dist;
      pointerTarget.x += ddx * k;
      pointerTarget.y += ddy * k;
      return;
    }
    pointerTarget.x = x;
    pointerTarget.y = y;
    pointerTarget.present = true;
  }
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

const zoneOf = (p: PointerParams): Zone => ({ x0: p.zoneX0, y0: p.zoneY0, x1: p.zoneX1, y1: p.zoneY1 });

// One source per app.
export const cameraPointer = new CameraPointer();
