import { createStore } from "./store";
import { OneEuro } from "./oneEuro";
import { loadParams, subscribeParams, type PointerParams } from "./pointerParams";
import { createHandWorker, type HandAssets, type HandOut, type WorkerOut } from "./handWorker";
import { ArticulationTracker } from "./articulation";
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
  hands: [] as { hand: "L" | "R"; pts: number[]; primary: boolean }[],
  version: 0,
  // Live tap-gesture state for the overlay, so a click that does not fire can be
  // told apart from a gesture that was never recognised.
  // Smoothed shape velocity per hand, keyed by handedness. Displayed only for
  // now: the arbiter that would use it is not wired up until the numbers show
  // the two hands actually separate during real use.
  articulation: { L: 0, R: 0 } as Record<"L" | "R", number>,
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
    pointerTarget.present = false;
    pointerStore.getState().set("off");
  }

  private applyParams(p: PointerParams) {
    this.params = p;
    this.fx = new OneEuro(p.minCutoff, p.beta);
    this.fy = new OneEuro(p.minCutoff, p.beta);
    this.fx2 = new OneEuro(p.minCutoff, p.beta);
    this.fy2 = new OneEuro(p.minCutoff, p.beta);
  }

  // Normalized frame coords -> screen px. The mirror (front camera) and the
  // active-zone mapping are the same for either hand, so both go through here.
  private toScreen(nx: number, ny: number) {
    const p = this.params;
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
    if (msg.hands.length === 0) {
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
      handDebug.hands = [];
      handDebug.version++;
      this.artic.L.reset();
      this.artic.R.reset();
      handDebug.articulation.L = 0;
      handDebug.articulation.R = 0;
      return;
    }
    this.dbg.hands++;
    // Pick the hand the user nominated. Falling back to whatever is in frame
    // matters: with one hand raised the cursor must work regardless of which
    // one it is. The choice only bites when BOTH hands are visible, which is
    // exactly when an arbitrary pick would feel broken.
    const want = pointerStore.getState().priority;
    const h = msg.hands.find((c) => c.hand === want) ?? msg.hands[0];
    const p = this.params;
    const t = msg.t / 1000;

    handDebug.hands = msg.hands.map((c) => ({ hand: c.hand, pts: c.pts, primary: c === h }));
    handDebug.version++;

    // Articulation per physical hand, and reset for whichever hand is absent so
    // a hand that leaves and returns does not read its re-entry as a gesture.
    const tSec = msg.t / 1000;
    for (const side of ["L", "R"] as const) {
      const seen = msg.hands.find((c) => c.hand === side);
      if (seen) handDebug.articulation[side] = this.artic[side].update(seen.pts, tSec);
      else {
        this.artic[side].reset();
        handDebug.articulation[side] = 0;
      }
    }

    // The other hand, if there is one. Tracked for two-handed gestures only.
    const o = msg.hands.find((c) => c !== h);
    if (o) {
      const od = Math.hypot(o.x - o.thumbX, o.y - o.thumbY);
      secondaryHand.pinching = secondaryHand.pinching ? od < p.pinchOff : od < p.pinchOn;
      const s = this.toScreen(this.fx2.filter(1 - o.x, t), this.fy2.filter(o.y, t));
      secondaryHand.x = s.x;
      secondaryHand.y = s.y;
      secondaryHand.present = true;
      secondaryHand.lastSeen = performance.now();
    } else if (performance.now() - secondaryHand.lastSeen > GONE_MS) {
      secondaryHand.present = false;
      secondaryHand.pinching = false;
    }
    // Pinch-to-click: thumb-tip to index-tip distance in normalized space, with
    // hysteresis so a click does not flicker at the threshold.
    const pinchDist = Math.hypot(h.x - h.thumbX, h.y - h.thumbY);
    pointerTarget.pinching = pointerTarget.pinching
      ? pinchDist < p.pinchOff
      : pinchDist < p.pinchOn;

    // mirror x (front camera), de-jitter in normalized space, then active zone
    // -> full screen (same mapping the second hand goes through).
    const { x, y } = this.toScreen(this.fx.filter(1 - h.x, t), this.fy.filter(h.y, t));
    pointerTarget.lastSeen = performance.now();

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

// One source per app.
export const cameraPointer = new CameraPointer();
