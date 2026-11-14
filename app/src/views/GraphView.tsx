import { drawHolographicAgent, drawHolographicSpace, drawLockOn, drawProgressDial, drawTether } from "./drawHologram";
import { HUD_FONT, voiceSignal } from "../state/hud";
import { usePresentation, registerPresentationScene, presentationAnchor } from "../state/presentation";
import { presentationLayout, PRESENTATION_FOLD_MS } from "../core/presentation";
import { drawAsset } from "./drawAsset";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { useVault } from "../state/store";
import { useAgents } from "../state/agents";
import { composeGraph, type GNode } from "../core/graph";
import { ZOOM_MAX, fieldOf, minZoom } from "../core/field";
import { springProgress, springForSettleMs, LAYOUT, type SpringToken } from "../motion/springs";
import { SpringValue } from "../motion/SpringValue";
import { subscribeFrame } from "../motion/ticker";
import {
  clickSlop,
  dispatchAction,
  registerActionHandler,
  setMagnetProvider,
  PRIORITY,
  type Action,
  type MagnetTarget,
} from "../input";

function agentStatusLabel(node: GNode) {
  const state = usePresentation.getState();
  if (state.active?.leadAgentId && node.id === `agent:${state.active.leadAgentId}`) return state.phase === 'returning' ? 'Returning to team' : 'Presenting result';
  return node.status === 'running' ? 'Working' : node.status === 'unavailable' ? 'Not available' : node.activity === 'done' ? 'Ready to review' : node.activity === 'failed' ? 'Needs attention' : 'Ready to help';
}

// The short status word projected under each teammate.
function hudStatus(node: GNode) {
  const state = usePresentation.getState();
  if (state.active?.leadAgentId && node.id === `agent:${state.active.leadAgentId}`) return state.phase === 'returning' ? 'Returning' : 'Presenting';
  return node.status === 'running' ? 'Working' : node.status === 'unavailable' ? 'Offline' : node.activity === 'done' ? 'Result ready' : node.activity === 'failed' ? 'Needs attention' : 'Standing by';
}

// The scene sits a little above centre, leaving the floor to the voice core.
const SCENE_Y = 58;

// Premium entrance: critically damped, no overshoot (matches the marble feel).
const APPEAR: SpringToken = "calm";

const COLORS: Record<GNode["type"], string> = {
  note: "#e8e8ea",
  section: "#2dd4bf",
  url: "#6b7280",
  agent: "#ffffff",
  task: "#8b949e",
  artifact: "#39d98a",
  swarm: "#a78bfa",
  post: "#8b5cf6",
};

// Graph-unit hit radius per node type (generous; nearest node wins).
const HIT: Record<GNode["type"], number> = { note: 11, section: 8, url: 7, agent: 24, task: 10, artifact: 15, swarm: 20, post: 7 };

// Drawn node radius per type, in graph units (matches nodeCanvasObject). Times
// the zoom `k` this is how big the node reads on screen, which sets the magnet's
// capture field: a node the size of a few px still gets a comfortable target.
const VIS_R: Record<GNode["type"], number> = { note: 7, section: 4.5, url: 3, agent: 20, task: 6, artifact: 9, swarm: 14, post: 3 };

// Magnet field geometry (screen px). Capture grows with the node's on-screen
// size but never shrinks below MIN_CAPTURE (so a tiny node at low zoom is still
// easy to grab) nor past MAX_CAPTURE (so a dense cluster doesn't over-glue).
// LOCK is the inner radius the cursor fully sits on; RELEASE widens the field
// once locked, so a resting hand doesn't flicker between neighbors.
const MAGNET = { margin: 18, minCapture: 44, maxCapture: 96, minLock: 12, release: 1.6 };
const clampN = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

// Visit /?debug to trace clicks/hovers in the browser console.
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");

// Pixels the pointer may wander between press and release while still counting as
// a click. Below this, a click that jitters a few px still opens the node; above
// it, the gesture is a pan (reposition the view). Mouse-sized: every use goes
// through clickSlop(), which raises the floor while a hand is driving, since a
// hand cannot hold within a few px and would never register a click.
const DRAG_THRESHOLD = 4;

// Zoom smoothing constants; see zoomTau.
const ZOOM_TAU_FINE = 0.06; // wheel / trackpad, arrives at display rate
const ZOOM_TAU_GESTURE = 0.13; // camera gesture, arrives at inference rate

// How long the hover ring takes to charge. Was also the dwell-to-open delay,
// which is gone; the ring is now pure hover feedback and opening is a click.
const HOVER_RING_MS = 300;

const REDUCED_MOTION =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function GraphView({ ambientMotion = true }: { ambientMotion?: boolean }) {
  const notes = useVault((s) => s.notes);
  const agents = useAgents((s) => s.agents);
  const tasks = useAgents((s) => s.tasks);
  const swarms = useAgents((s) => s.swarms);
  const selectedId = useVault((s) => s.selectedId);
  const select = useVault((s) => s.select);
  const clear = useVault((s) => s.clear);

  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  // Persistent node objects keyed by id. Reusing them across rebuilds keeps the
  // x/y the simulation assigned, so an update only animates the changed nodes
  // instead of relaying out (and visibly twitching) the whole graph.
  const nodeCache = useRef(new Map<string, any>());
  // When each node first appeared, for the fade/grow-in animation.
  const bornAt = useRef(new Map<string, number>());
  const nodeMotions = useRef(new Map<string, { x: SpringValue; y: SpringValue }>());
  const presentation = usePresentation(s => s.active);
  const presentationPhase = usePresentation(s => s.phase);
  const activityAt = useRef(new Map<string, { key: string; at: number }>());
  const stepAt = useRef(new Map<string, { text: string; at: number }>());
  const sceneEnergy = useRef(0);
  const sceneLevel = useRef(0);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [hovered, setHovered] = useState<string | null>(null);

  // Spring-animated selection/hover rings, advanced by the one shared ticker.
  // The hover ring "charges" over the open dwell, filling as the view opens.
  const hoverRing = useRef(new SpringValue(springForSettleMs(HOVER_RING_MS), 0));
  const selectRing = useRef(new SpringValue("responsive", 0));
  const ringNode = useRef<{ hover: string | null; select: string | null }>({ hover: null, select: null });
  const ticking = useRef(false);
  const lastTickMs = useRef(0);

  // Flag the force-graph's own render loop to repaint the canvas, without forcing
  // a React reconcile of this subtree (which would re-push accessor props into the
  // library every call). A no-op recenter sets the library's internal needsRedraw.
  const requestRedraw = useCallback(() => {
    const fg = fgRef.current;
    if (fg && camInit.current) fg.centerAt(centerX.current.value, centerY.current.value);
  }, []);

  // Camera: zoom (k) and center are springs, advanced by the shared ticker and
  // written to the canvas transform once per frame, so pan and zoom compose. A
  // drag flings the center with inertia; the center spring settles it.
  const kRef = useRef(1);
  const camInit = useRef(false);
  const centerX = useRef(new SpringValue("calm", 0));
  const centerY = useRef(new SpringValue("calm", 0));
  const zoomDispLog = useRef(0); // displayed log(zoom), eased toward the target
  const zoomTargetLog = useRef<number | null>(null);
  const zoomAnchor = useRef({ sx: 0, sy: 0 }); // cursor position in canvas px
  const zoomActive = useRef(false);
  // Smoothing time constant for the displayed zoom. It has to be at least the
  // interval between inputs or the display lands on target between them and the
  // motion steps: a wheel or trackpad streams at display rate, but the camera
  // gesture arrives at the ~15fps inference rate, i.e. every ~66ms.
  const zoomTau = useRef(ZOOM_TAU_FINE);
  const dragging = useRef(false);
  const camWasMoving = useRef(false); // paint one trailing frame on settle (exact snap)
  // The node the press began on, if any. An id rather than a boolean, because a
  // press that starts on a node opens THAT node however far the hand drifts
  // afterwards; picking again at release would open a neighbour or nothing.
  const downNode = useRef<string | null>(null);
  const lastPtr = useRef<{ x: number; y: number } | null>(null);
  const lastMoveT = useRef(0);
  const panVel = useRef({ x: 0, y: 0 }); // center-space velocity, units/sec

  // Magnet: live node list (read by the provider, which is registered once) and
  // the id just closed, suppressed from re-locking until the hand leaves it so the
  // magnet doesn't glue the cursor back onto a node and immediately re-open it.
  const nodesRef = useRef<any[]>([]);
  const suppressId = useRef<string | null>(null);
  const openId = useRef<string | null>(null);
  // Cached stage rect for the per-frame provider (a getBoundingClientRect per
  // frame is a layout read on the CV-shared thread); refreshed on resize.
  const stageRect = useRef<DOMRect | null>(null);

  const ensureViewInit = useCallback(() => {
    const fg = fgRef.current;
    const el = wrapRef.current;
    if (!fg || !el || camInit.current) return;
    // The pinned agent ring is centered on the origin. Frame it before the
    // first interaction, including when discovery has not returned yet.
    const zoom = Math.min(1.25, Math.max(.5, Math.min(el.clientWidth / 1100, (el.clientHeight - 280) / 600)));
    centerX.current.jump(0);
    centerY.current.jump(SCENE_Y);
    fg.zoom(zoom);
    fg.centerAt(0, SCENE_Y);
    kRef.current = zoom;
    zoomDispLog.current = Math.log(kRef.current);
    camInit.current = true;
  }, []);

  // Reframe after the canvas receives its real dimensions. This also avoids
  // clipping teammates when a projector or window changes aspect ratio.
  useEffect(() => {
    camInit.current = false;
    ensureViewInit();
    fgRef.current?.resumeAnimation?.();
    fgRef.current?.d3ReheatSimulation?.();
  }, [size.w, size.h, ensureViewInit]);

  const startTicking = useCallback(() => {
    if (ticking.current) return;
    ticking.current = true;
    const stop = subscribeFrame(() => {
      const tNow = performance.now();
      const now = tNow / 1000;
      let dt = (tNow - lastTickMs.current) / 1000;
      if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
      lastTickMs.current = tNow;

      const a = hoverRing.current.update(now);
      const b = selectRing.current.update(now);

      let camMoving = false;
      const fg = fgRef.current;
      const el = wrapRef.current;
      if (fg && el && camInit.current) {
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (zoomActive.current) {
          // Light exponential smoothing toward the target: continuous (no
          // settle-from-rest steps that chop a long pinch) with a touch of glide.
          const tgt = zoomTargetLog.current ?? zoomDispLog.current;
          const f = REDUCED_MOTION ? 1 : 1 - Math.exp(-dt / zoomTau.current);
          const nextLog = zoomDispLog.current + (tgt - zoomDispLog.current) * f;
          const kNew = Math.exp(nextLog);
          // Keep the cursor's world point fixed; shift the center spring rigidly.
          const { sx, sy } = zoomAnchor.current;
          const worldX = centerX.current.value + (sx - w / 2) / kRef.current;
          const worldY = centerY.current.value + (sy - h / 2) / kRef.current;
          centerX.current.shift(worldX - (sx - w / 2) / kNew - centerX.current.value);
          centerY.current.shift(worldY - (sy - h / 2) / kNew - centerY.current.value);
          kRef.current = kNew;
          zoomDispLog.current = nextLog;
          if (Math.abs(tgt - nextLog) < 1e-4) {
            zoomDispLog.current = tgt;
            kRef.current = Math.exp(tgt);
            zoomActive.current = false;
          }
          camMoving = true;
        }
        const csx = centerX.current.update(now);
        const csy = centerY.current.update(now);
        if (!csx || !csy || dragging.current) camMoving = true;
        if (camMoving || camWasMoving.current) {
          // Both setters flag the library's own redraw, so the canvas repaints on
          // the next internal frame without a React reconcile. The trailing frame
          // (camWasMoving, now settled) paints the exact on-target snap.
          fg.zoom(kRef.current);
          fg.centerAt(centerX.current.value, centerY.current.value);
        } else if (!a || !b) {
          // Only the rings are animating (no camera motion). Nudge the library to
          // repaint via a no-op recenter; cheaper than re-rendering React.
          requestRedraw();
        }
        camWasMoving.current = camMoving;
      }

      if (a && b && !camMoving) {
        ticking.current = false;
        stop(); // stop on settle
      }
    });
  }, [requestRedraw]);

  // The graph is the world surface: it claims a zoom only when nothing in front
  // of it did (an open note outranks it, see input/actions.ts). Registered at
  // PRIORITY.world, and always returns true, since the canvas is the floor of
  // the chain and there is nothing behind it to fall through to.
  const onZoom = useCallback(
    (a: Action) => {
      const el = wrapRef.current;
      if (!fgRef.current || !el) return false;
      // Pan: shift the centre against the gesture so the content follows the
      // hands, the same convention as the drag-pan below. Divided by k because
      // the centre lives in graph units while the action is in viewport px.
      if (a.type === "pan") {
        ensureViewInit();
        // setTarget, not jump: the spring turns ~15fps gesture samples into
        // display-rate motion. A rigid jump is right for a mouse drag, which
        // already arrives every frame, and visibly steppy for a hand.
        centerX.current.setTarget(centerX.current.goal - a.dx / kRef.current);
        centerY.current.setTarget(centerY.current.goal - a.dy / kRef.current);
        startTicking();
        return true;
      }
      if (a.type !== "zoom") return false;
      const rect = el.getBoundingClientRect();
      zoomAnchor.current = { sx: a.x - rect.left, sy: a.y - rect.top };
      ensureViewInit();
      if (zoomTargetLog.current == null) zoomTargetLog.current = zoomDispLog.current;
      // Pinch deltas are small and continuous, so they get more gain than a
      // wheel notch. The displayed zoom eases toward this target in the ticker,
      // so a long pinch and a single notch both stay smooth.
      zoomTau.current = a.pinch ? ZOOM_TAU_GESTURE : ZOOM_TAU_FINE;
      const sensitivity = a.pinch ? 0.01 : 0.0015;
      const field = fieldOf(nodesRef.current);
      const min = Math.log(minZoom(field, el.clientWidth, el.clientHeight));
      const max = Math.log(ZOOM_MAX);
      zoomTargetLog.current = Math.min(
        max,
        Math.max(min, zoomTargetLog.current - a.delta * sensitivity),
      );
      zoomActive.current = true;
      startTicking();
      return true;
    },
    [ensureViewInit, startTicking],
  );

  useEffect(() => registerActionHandler(onZoom, PRIORITY.world), [onZoom]);

  // A real wheel or trackpad pinch enters the same chain, so it reaches whatever
  // is in front rather than always the canvas underneath.
  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16; // lines -> px
    else if (e.deltaMode === 2) dy *= 100; // pages -> px
    dispatchAction({ type: "zoom", delta: dy, x: e.clientX, y: e.clientY, pinch: e.ctrlKey });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const data = useMemo(() => {
    const built = composeGraph(notes, agents, tasks, false, swarms);
    const cache = nodeCache.current;
    const liveIds = new Set(built.nodes.map((n) => n.id));
    for (const id of [...cache.keys()]) {
      if (!liveIds.has(id)) {
        cache.delete(id);
        bornAt.current.delete(id);
        nodeMotions.current.delete(id);
      }
    }

    const nodes = built.nodes.map((n) => {
      const prev = cache.get(n.id);
      if (prev) {
        prev.label = n.label; // a renamed heading updates in place, no restructure
        prev.type = n.type;
        prev.artifactType = n.artifactType;
        prev.available = n.available;
        prev.status = n.status;
        prev.progress = n.progress;
        prev.activity = n.activity;
        prev.badge = n.badge;
        prev.activityKey = n.activityKey;
        prev.artifactCount = n.artifactCount;
        prev.artifactReady = n.artifactReady;
        prev.startedAt = n.startedAt;
        prev.step = n.step;
        if (n.fx != null) {
          prev.homeX = n.x;
          prev.homeY = n.y;
          if (!nodeMotions.current.has(n.id)) { prev.x = n.x; prev.y = n.y; prev.fx = n.fx; prev.fy = n.fy; }
        }
        return prev; // retain the simulation object and its visual state
      }
      Object.assign(n, { homeX: n.x, homeY: n.y });
      cache.set(n.id, n);
      bornAt.current.set(n.id, performance.now());
      return n;
    });

    return { nodes, links: built.links };
  }, [notes, agents, tasks, swarms]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      stageRect.current = el.getBoundingClientRect();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => registerPresentationScene(id => {
    const node = nodeCache.current.get(`agent:${id}`);
    const fg = fgRef.current;
    if (!node || !fg || !wrapRef.current) return null;
    const rect = wrapRef.current.getBoundingClientRect();
    const point = fg.graph2ScreenCoords(node.x, node.y);
    return { x: rect.left + point.x, y: rect.top + point.y };
  }), []);

  useEffect(() => {
    if (!presentation || !['approaching', 'returning'].includes(presentationPhase)) return;
    return subscribeFrame(() => requestRedraw());
  }, [presentation?.key, presentationPhase, requestRedraw]);

  function positionPresentingAgent() {
    const fg = fgRef.current;
    const element = wrapRef.current;
    if (!fg || !element || !camInit.current) return;
    const current = usePresentation.getState();
    const rect = element.getBoundingClientRect();
    const dock = presentationLayout(rect.width, rect.height).dock;
    const dockWorld = fg.screen2GraphCoords(dock.x, dock.y);
    const holding = current.active && (current.phase !== 'returning' || performance.now() - current.phaseAt < PRESENTATION_FOLD_MS);
    for (const node of nodeCache.current.values()) {
      if (node.type !== 'agent') continue;
      let motion = nodeMotions.current.get(node.id);
      if (!motion) {
        motion = { x: new SpringValue({ zeta: 1, omega: 14 }, node.x), y: new SpringValue({ zeta: 1, omega: 14 }, node.y) };
        nodeMotions.current.set(node.id, motion);
      }
      const presenting = holding && node.id === `agent:${current.active?.leadAgentId}`;
      const target = presenting ? dockWorld : { x: node.homeX, y: node.homeY };
      if (REDUCED_MOTION) { motion.x.jump(target.x); motion.y.jump(target.y); }
      else { motion.x.setTarget(target.x); motion.y.setTarget(target.y); motion.x.update(); motion.y.update(); }
      node.x = node.fx = motion.x.value;
      node.y = node.fy = motion.y.value;
      if (node.id === `agent:${current.active?.leadAgentId}`) {
        const point = fg.graph2ScreenCoords(node.x, node.y);
        presentationAnchor.x = rect.left + point.x;
        presentationAnchor.y = rect.top + point.y;
      }
    }
  }

  // Keep the provider's node list current without re-registering it each frame.
  nodesRef.current = data.nodes as any[];

  // Publish the magnet field: given the raw cursor, return the node worth snapping
  // to (viewport px + zoom-aware capture/lock radii), or null. Registered once;
  // reads everything live via refs and the store, so it always sees the current
  // camera, zoom, and selection. Kept cheap because it runs per moving frame on
  // the CV-shared thread: one screen->graph transform, then plain distance math
  // in graph units; DOM work (one elementFromPoint) only once a candidate exists.
  useEffect(() => {
    const el = wrapRef.current;
    const capturePx = (n: any, k: number) =>
      clampN((VIS_R[n.type as GNode["type"]] ?? 3) * k + MAGNET.margin, MAGNET.minCapture, MAGNET.maxCapture);
    const target = (n: any, rect: DOMRect, k: number): MagnetTarget => {
      const s = fgRef.current.graph2ScreenCoords(n.x, n.y);
      const rScreen = (VIS_R[n.type as GNode["type"]] ?? 3) * k;
      const capture = capturePx(n, k);
      return {
        id: n.id,
        x: rect.left + s.x,
        y: rect.top + s.y,
        capture,
        lock: clampN(rScreen, MAGNET.minLock, capture * 0.6),
      };
    };

    setMagnetProvider((x, y, preferId) => {
      const fg = fgRef.current;
      if (!fg || !el || !camInit.current) return null;
      // Hard off while a node is open AND through the close fade: the graph is
      // occluded (or still fading back in), so there must be no pull at all,
      // and no re-gluing the cursor onto a node the moment a view closes.
      if (useVault.getState().selectedId) return null;
      const k = kRef.current;
      const rect = stageRect.current ?? (stageRect.current = el.getBoundingClientRect());
      // One transform for the cursor, none per node: compare in graph units
      // (screen px / k) against each node's capture field.
      const p = fg.screen2GraphCoords(x - rect.left, y - rect.top);
      const distPx = (n: any) => Math.hypot(n.x - p.x, n.y - p.y) * k;
      const nodes = nodesRef.current;

      // Re-arm the just-closed node once the hand has left its (widened) field.
      if (suppressId.current) {
        const s = nodes.find((n) => n.id === suppressId.current);
        if (!s || s.x == null || distPx(s) > capturePx(s, k) * MAGNET.release)
          suppressId.current = null;
      }

      // The locked node keeps the cursor while it stays inside the widened
      // release field (hysteresis), so a tremor doesn't hop between neighbors.
      let candidate: any = null;
      if (preferId && preferId !== suppressId.current) {
        const n = nodes.find((nn) => nn.id === preferId);
        if (n && n.x != null && distPx(n) <= capturePx(n, k) * MAGNET.release) candidate = n;
      }

      // Otherwise acquire the nearest node whose capture field holds the cursor.
      if (!candidate) {
        let bestD = Infinity;
        for (const n of nodes) {
          if (n.x == null || n.y == null || n.id === suppressId.current) continue;
          const d = distPx(n);
          if (d <= capturePx(n, k) && d < bestD) {
            bestD = d;
            candidate = n;
          }
        }
      }
      if (!candidate) return null;
      // The pull must not fight what is really under the cursor: if another
      // surface occludes the stage here (corner buttons, header), no magnet.
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit)) return null;
      return target(candidate, rect, k);
    });
    return () => setMagnetProvider(null);
  }, []);

  // Configure forces once.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force("collide", forceCollide((n: any) => HIT[n.type as GNode["type"]] + 4).strength(1).iterations(2));
    fg.d3Force("charge")?.strength(0);
    fg.d3Force("link")?.distance(24);
  }, []);

  // Reheat only when the set of nodes changes (add/remove), so a new node finds
  // its place. Content-only edits don't reheat, so unchanged nodes stay put and
  // the update reads as smooth rather than a full relayout.
  const nodeIdsKey = data.nodes.map((n: any) => n.id).join("|");
  useEffect(() => {
    fgRef.current?.d3ReheatSimulation?.();
  }, [nodeIdsKey]);

  useEffect(() => {
    if (REDUCED_MOTION || !ambientMotion) { requestRedraw(); return; }
    // The projection is alive: repaint on the shared ticker so rings, comets and
    // scanlines move at display rate. No React updates per frame, and hidden
    // pages do not spend time animating.
    return subscribeFrame(() => {
      if (!document.hidden) requestRedraw();
    });
  }, [requestRedraw, ambientMotion]);

  // Drive the rings toward present (1) / absent (0) on hover and selection.
  useEffect(() => {
    if (hovered) ringNode.current.hover = hovered;
    if (REDUCED_MOTION) {
      hoverRing.current.jump(hovered ? 1 : 0);
      requestRedraw();
    } else {
      hoverRing.current.setTarget(hovered ? 1 : 0);
      startTicking();
    }
  }, [hovered, startTicking, requestRedraw]);

  useEffect(() => {
    if (selectedId) {
      ringNode.current.select = selectedId;
      // Clear hover when a node opens. While the overlay is up the graph is
      // occluded and stops getting pointer moves, so a stale `hovered` would
      // otherwise survive and re-trigger the dwell-open the instant the view
      // closes (close -> reopen loop, most visible with the camera cursor).
      setHovered(null);
    }
    if (REDUCED_MOTION) {
      selectRing.current.jump(selectedId ? 1 : 0);
      requestRedraw();
    } else {
      selectRing.current.setTarget(selectedId ? 1 : 0);
      startTicking();
    }
  }, [selectedId, startTicking, requestRedraw]);

  // Opening is a click, never a dwell. Dwell made resting the cursor a
  // commitment, which is the wrong default for a pointer that is always resting
  // somewhere, and it forced a reopen-blocking timer to stop a node reopening
  // the instant it closed. Both are gone; only the magnet suppression below
  // survives, and on its own merit (do not yank the cursor back onto the node
  // that was just dismissed).
  useEffect(() => {
    if (selectedId) openId.current = selectedId;
    else suppressId.current = openId.current;
  }, [selectedId]);

  // Manual hit-testing: convert the cursor to graph coords and pick the nearest
  // node within its radius. Bypasses the library's pointer-area canvas, where
  // overlapping nodes could bury one another and become unclickable.
  function pick(clientX: number, clientY: number): any {
    const fg = fgRef.current;
    const el = wrapRef.current;
    if (!fg || !el) return null;
    const rect = el.getBoundingClientRect();
    const p = fg.screen2GraphCoords(clientX - rect.left, clientY - rect.top);
    let best: any = null;
    let bestD = Infinity;
    for (const n of data.nodes as any[]) {
      if (n.x == null || n.y == null) continue;
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const d = dx * dx + dy * dy;
      const r = Math.max(HIT[n.type as GNode["type"]], 40 / kRef.current);
      if (d <= r * r && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  return (
    <div
      className={`stage${selectedId ? " blurred" : ""}`}
      ref={wrapRef}
      onPointerDown={(e) => {
        downRef.current = { x: e.clientX, y: e.clientY };
        lastPtr.current = { x: e.clientX, y: e.clientY };
        lastMoveT.current = performance.now();
        panVel.current = { x: 0, y: 0 };
        dragging.current = false;
        downNode.current = pick(e.clientX, e.clientY)?.id ?? null;
        if (DEBUG)
          console.debug(`[graph] pointerdown at ${e.clientX.toFixed(0)},${e.clientY.toFixed(0)} node=`, downNode.current);
        ensureViewInit();
        // Grabbing cancels any in-flight pan coast (zoom momentum is kept).
        centerX.current.jump(centerX.current.value);
        centerY.current.jump(centerY.current.value);
        // Synthetic pointers (the camera cursor) have no active pointer to
        // capture, so guard against the throw.
        try {
          wrapRef.current?.setPointerCapture?.(e.pointerId);
        } catch {
          /* no real pointer to capture */
        }
      }}
      onPointerMove={(e) => {
        const el = wrapRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        zoomAnchor.current = { sx: e.clientX - rect.left, sy: e.clientY - rect.top };
        if (e.buttons & 1 && lastPtr.current && downRef.current) {
          // A press that began on a node never becomes a pan. The halo is a
          // promise: if it is lit, pressing opens that node, and no amount of
          // hand drift reinterprets the gesture as relocating the canvas.
          // Panning is for empty background, where there is nothing to open.
          if (downNode.current) return;
          // Let a pinch settle before interpreting its small drift as a pan.
          // Follow the last pointer so crossing the threshold starts smoothly.
          if (
            !dragging.current &&
            Math.hypot(e.clientX - downRef.current.x, e.clientY - downRef.current.y) <=
              clickSlop(DRAG_THRESHOLD)
          ) {
            lastPtr.current = { x: e.clientX, y: e.clientY };
            lastMoveT.current = performance.now();
            return;
          }
          // Drag = pan, 1:1. Move the center rigidly and track velocity for fling.
          const t = performance.now();
          const dt = Math.max(1, t - lastMoveT.current) / 1000;
          const gdx = (e.clientX - lastPtr.current.x) / kRef.current;
          const gdy = (e.clientY - lastPtr.current.y) / kRef.current;
          centerX.current.jump(centerX.current.value - gdx);
          centerY.current.jump(centerY.current.value - gdy);
          panVel.current.x = panVel.current.x * 0.6 + (-gdx / dt) * 0.4;
          panVel.current.y = panVel.current.y * 0.6 + (-gdy / dt) * 0.4;
          lastPtr.current = { x: e.clientX, y: e.clientY };
          lastMoveT.current = t;
          dragging.current = true;
          el.style.cursor = "grabbing";
          startTicking();
        } else {
          const n = pick(e.clientX, e.clientY);
          setHovered(n ? n.id : null);
          el.style.cursor = n ? "pointer" : "grab";
        }
      }}
      onPointerUp={(e) => {
        // Mirror of the guarded setPointerCapture in onPointerDown. The camera
        // cursor's synthetic pointer has no real capture to release, and
        // releasePointerCapture THROWS on an uncaptured id. Unguarded, that
        // threw on the first line and aborted the rest of this handler, so a
        // hand-driven press never reached select() and no node ever opened,
        // while the real mouse (whose capture did succeed) worked fine.
        try {
          wrapRef.current?.releasePointerCapture?.(e.pointerId);
        } catch {
          /* no real pointer was captured */
        }
        lastPtr.current = null;
        const wasDrag = dragging.current;
        dragging.current = false;
        const d = downRef.current;
        const pressed = downNode.current;
        downRef.current = null;
        downNode.current = null;
        if (wasDrag) {
          // Fling: throw the center with the release velocity; the spring settles it.
          const { x: vx, y: vy } = panVel.current;
          if (Math.hypot(vx, vy) > 5) {
            const coast = 0.12;
            centerX.current.setTarget(centerX.current.value + vx * coast, vx);
            centerY.current.setTarget(centerY.current.value + vy * coast, vy);
            startTicking();
          }
          return; // a pan, not a click
        }
        // Pressed on a node: open exactly that one, no distance test and no
        // re-pick at the release point. The hand will have drifted, and picking
        // again would open whatever it drifted onto, or nothing at all.
        if (DEBUG) console.debug("[graph] pointerup, pressed node =", pressed, "wasDrag =", wasDrag);
        if (pressed) {
          if (DEBUG) console.debug("[graph] click:", pressed);
          select(pressed);
          return;
        }
        // Pressed on empty background: a short press dismisses any open view, a
        // long drag was a pan and already returned above.
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > clickSlop(DRAG_THRESHOLD)) return;
        if (DEBUG) console.debug("[graph] click: (background)");
        clear();
      }}
      onPointerCancel={() => {
        // A gesture took the press over (a second hand joining to zoom). Drop
        // the press state without selecting anything and without touching
        // hover: no click was completed, and the pointer has not gone anywhere.
        dragging.current = false;
        downRef.current = null;
        downNode.current = null;
        lastPtr.current = null;
        if (wrapRef.current) wrapRef.current.style.cursor = "grab";
      }}
      onPointerLeave={() => {
        if (!dragging.current) setHovered(null);
      }}
    >
      <div className="canvas-node-access" aria-label="Canvas items" onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}>
        {data.nodes.filter(node => node.type === 'agent' || node.type === 'artifact' || node.type === 'swarm').map(node => <button key={node.id} onClick={() => select(node.id)}>{node.label}{node.type === 'agent' ? `: ${agentStatusLabel(node)}` : ''}</button>)}
      </div>
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data}
        onRenderFramePre={(ctx, scale) => {
          positionPresentingAgent();
          const still = REDUCED_MOTION || !ambientMotion;
          const time = performance.now() / 1000;
          // The room answers the voice: rings brighten while you are heard.
          const wanted = voiceSignal.speaking || voiceSignal.status === 'armed' || voiceSignal.status === 'listening' ? 1 : voiceSignal.status === 'wake' ? .35 : 0;
          sceneEnergy.current += (wanted - sceneEnergy.current) * (still ? 1 : .06);
          sceneLevel.current += (voiceSignal.level - sceneLevel.current) * (still ? 1 : .2);
          const presenting = usePresentation.getState().active;
          ctx.save();
          if (presenting) ctx.globalAlpha = .45;
          drawHolographicSpace(ctx, { time: still ? 0 : time, scale, reduced: still, energy: sceneEnergy.current, level: still ? 0 : sceneLevel.current });
          for (const node of nodeCache.current.values()) {
            if (node.type !== 'agent' || node.x == null || node.status === 'unavailable') continue;
            if (Math.hypot(node.x - node.homeX, node.y - node.homeY) > 4) continue; // away presenting
            const born = bornAt.current.get(node.id) ?? 0;
            const appear = REDUCED_MOTION ? 1 : Math.max(0, Math.min(1, (performance.now() - born - 250) / 700));
            drawTether(ctx, node.x, node.y, Math.max(22, Math.min(36 / scale, 52)), { time, scale, working: node.status === 'running', reduced: still, alpha: appear,
              // A task being handed over: one bright charge runs out to the agent.
              burst: node.status === 'running' ? time - (activityAt.current.get(node.id)?.at ?? -100) : 99 });
          }
          ctx.restore();
        }}
        onEngineTick={() => {
          const fg = fgRef.current;
          // The library auto-fits newly discovered nodes at its default zoom.
          // Keep the gesture camera authoritative, including on small screens.
          if (fg && camInit.current) {
            if (Math.abs(fg.zoom() - kRef.current) > 0.001) fg.zoom(kRef.current);
            const center = fg.centerAt();
            if (Math.abs(center.x - centerX.current.value) > 0.001 || Math.abs(center.y - centerY.current.value) > 0.001) {
              fg.centerAt(centerX.current.value, centerY.current.value);
            }
          }
        }}
        backgroundColor="rgba(0,0,0,0)"
        // Reduced motion: pre-settle off-screen so there's little visible
        // motion, but always keep cooldown ticks so the layout actually runs.
        warmupTicks={REDUCED_MOTION ? 120 : 0}
        cooldownTicks={120}
        d3VelocityDecay={LAYOUT.velocityDecay}
        enableNodeDrag={false}
        enableZoomInteraction={false} // zoom + pan handled by the unified ticker
        enablePanInteraction={false}
        linkColor={() => "rgba(130,205,255,0.16)"}
        nodeCanvasObject={(node: any, ctx, scale) => {
          const sel = node.id === selectedId;
          const hot = node.id === hovered;
          const still = REDUCED_MOTION || !ambientMotion;
          const tNow = performance.now();
          const now = tNow / 1000;
          // Entrance driven by the closed-form spring (analytic, O(1) per frame).
          const age = (tNow - (bornAt.current.get(node.id) ?? 0)) / 1000;
          const p = REDUCED_MOTION ? 1 : springProgress(APPEAR, age);
          const grow = Math.max(0, p);
          const baseR = node.type === 'agent' ? Math.max(22, Math.min(36 / scale, 52)) : node.type === 'swarm' ? Math.max(14, 22 / scale) : node.type === 'artifact' ? Math.max(12, 20 / scale) : VIS_R[node.type as GNode["type"]] ?? 3;
          const r = baseR * (0.45 + 0.55 * grow);
          const focus = usePresentation.getState().active;
          const focusAlpha = focus && node.id !== `agent:${focus.leadAgentId}` ? .28 : 1;
          const entranceAlpha = (p < 0 ? 0 : p > 1 ? 1 : p) * focusAlpha;
          // Spring-animated aim: carried velocity, so re-aiming never restarts.
          const selAmt = node.id === ringNode.current.select ? selectRing.current.value : 0;
          const hovAmt = node.id === ringNode.current.hover ? hoverRing.current.value : 0;
          const aim = Math.max(selAmt, hovAmt);
          const aimed = Math.max(0, Math.min(1, aim));
          ctx.globalAlpha = entranceAlpha;
          if (node.type === 'agent' || node.type === 'swarm') {
            let activity = activityAt.current.get(node.id);
            if (!activity || activity.key !== node.activityKey) {
              // The first sighting is history, not news: no completion pulse on load.
              activity = { key: node.activityKey, at: activity ? now : -100 };
              activityAt.current.set(node.id, activity);
            }
            drawHolographicAgent(ctx, node.x, node.y, r, node.id.replace('agent:', ''), {
              state: node.activity ?? 'waiting', time: now, elapsed: now - activity.at, reduced: still, focus: aimed,
            });
            if (node.status === 'running' && node.type === 'agent') drawProgressDial(ctx, node.x, node.y, r, { time: now, seconds: node.startedAt ? Math.max(0, (Date.now() - node.startedAt) / 1000) : now - activity.at, scale, reduced: still });
          } else if (node.type === 'artifact') {
            drawAsset(ctx, node.x, node.y, r, node.artifactType, node.artifactReady !== false, { time: now, age, reduced: still, focus: aimed });
          } else {
            ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = COLORS[node.type as GNode["type"]] ?? 'oklch(65% .01 260)';
            ctx.fill();
          }
          ctx.globalAlpha = entranceAlpha;
          if (node.badge) {
            ctx.fillStyle = 'oklch(16% .03 240)';
            ctx.fillRect(node.x - 7, node.y - 2.4, 14, 4.8);
            ctx.fillStyle = 'oklch(90% .05 210)'; ctx.font = `3px ${HUD_FONT}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(node.badge.toUpperCase(), node.x, node.y);
          }
          drawLockOn(ctx, node.x, node.y, node.type === 'artifact' ? r * .95 : r, aim, scale, selAmt >= hovAmt && selAmt > 0);
          if ((node.type !== 'post' || sel || hot) && (scale > 1.3 || node.type === "note" || node.type === 'agent' || node.type === 'task' || node.type === 'artifact' || node.type === 'swarm' || sel || hot)) {
            const lead = node.type === 'agent';
            const spacing = (value: number) => { if ('letterSpacing' in ctx) (ctx as any).letterSpacing = `${value / scale}px`; };
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.font = `${lead ? 600 : 500} ${(lead ? 13.5 : 11.5) / scale}px ${HUD_FONT}`;
            spacing(lead ? 2.6 : .5);
            ctx.fillStyle = sel || hot ? "oklch(97% .02 205)" : lead ? "oklch(91% .03 215)" : "oklch(82% .04 222)";
            const limit = node.type === 'artifact' ? 18 : 30;
            const text = node.label.length > limit ? node.label.slice(0, limit - 1) + '…' : node.label;
            const top = node.y + r * (lead ? (node.status === 'running' ? 1.82 : 1.5) : node.type === 'artifact' ? 1.42 : 1.3) + 7 / scale;
            ctx.fillText(lead ? text.toUpperCase() : text, node.x, top);
            if (lead) {
              ctx.font = `500 ${9.5 / scale}px ${HUD_FONT}`;
              spacing(1.9);
              ctx.fillStyle = node.activity === 'failed' ? 'oklch(82% .13 70)' : node.status === 'running' || node.activity === 'done' ? 'oklch(84% .11 208)' : 'oklch(64% .04 228)';
              const working = node.status === 'running' && !usePresentation.getState().active;
              const since = working ? Math.max(0, Math.floor(node.startedAt ? (Date.now() - node.startedAt) / 1000 : 0)) : 0;
              const clock = working && node.startedAt ? `  ${String(Math.floor(since / 60)).padStart(2, '0')}:${String(since % 60).padStart(2, '0')}` : '';
              ctx.fillText(hudStatus(node).toUpperCase() + clock, node.x, top + 20 / scale);
              if (working && node.step) {
                // What the agent just said it is doing, typed out as it changes.
                let typed = stepAt.current.get(node.id);
                if (!typed || typed.text !== node.step) { typed = { text: node.step, at: now }; stepAt.current.set(node.id, typed); }
                const shown = still ? node.step : node.step.slice(0, Math.floor((now - typed.at) * 46));
                spacing(.2);
                ctx.font = `400 ${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
                ctx.fillStyle = 'oklch(80% .04 220)';
                ctx.fillText(shown + (!still && shown.length < node.step.length ? '▍' : ''), node.x, top + 37 / scale);
              }
            }
            spacing(0);
          }
          ctx.globalAlpha = 1;
        }}
      />
    </div>
  );
}
