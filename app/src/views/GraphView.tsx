import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { forceCollide } from "d3-force-3d";
import { useVault } from "../state/store";
import { useAgents } from "../state/agents";
import { composeGraph, type GNode } from "../core/graph";
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

// Premium entrance: critically damped, no overshoot (matches the marble feel).
const APPEAR: SpringToken = "calm";

const COLORS: Record<GNode["type"], string> = {
  note: "#e8e8ea",
  section: "#2dd4bf",
  url: "#6b7280",
  agent: "#ffffff",
  task: "#39d98a",
  artifact: "#65a9ff",
};

// Graph-unit hit radius per node type (generous; nearest node wins).
const HIT: Record<GNode["type"], number> = { note: 11, section: 8, url: 7, agent: 11, task: 10, artifact: 13 };

// Drawn node radius per type, in graph units (matches nodeCanvasObject). Times
// the zoom `k` this is how big the node reads on screen, which sets the magnet's
// capture field: a node the size of a few px still gets a comfortable target.
const VIS_R: Record<GNode["type"], number> = { note: 7, section: 4.5, url: 3, agent: 7, task: 6, artifact: 6 };

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

export default function GraphView() {
  const notes = useVault((s) => s.notes);
  const agents = useAgents((s) => s.agents);
  const tasks = useAgents((s) => s.tasks);
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
  const [size, setSize] = useState({ w: 800, h: 600 });
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
    const c = fg.screen2GraphCoords(el.clientWidth / 2, el.clientHeight / 2);
    centerX.current.jump(c.x);
    centerY.current.jump(c.y);
    kRef.current = fg.zoom() || 1;
    zoomDispLog.current = Math.log(kRef.current);
    camInit.current = true;
  }, []);

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
      const min = Math.log(0.3);
      const max = Math.log(12);
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
    const built = composeGraph(notes, agents, tasks);
    const cache = nodeCache.current;
    const liveIds = new Set(built.nodes.map((n) => n.id));
    for (const id of [...cache.keys()]) {
      if (!liveIds.has(id)) {
        cache.delete(id);
        bornAt.current.delete(id);
      }
    }

    const nodes = built.nodes.map((n) => {
      const prev = cache.get(n.id);
      if (prev) {
        prev.label = n.label; // a renamed heading updates in place, no restructure
        prev.type = n.type;
        prev.artifactType = n.artifactType;
        return prev; // keep x/y/vx/vy
      }
      cache.set(n.id, n);
      bornAt.current.set(n.id, performance.now());
      return n;
    });

    // Seed each new node at its parent's position so it eases out from there
    // rather than flying in from the origin.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const link of built.links) {
      const target = byId.get(link.target);
      const source = byId.get(link.source);
      if (target && target.x == null && source && source.x != null) {
        target.x = source.x + (Math.random() - 0.5) * 8;
        target.y = source.y + (Math.random() - 0.5) * 8;
      }
    }

    return { nodes, links: built.links };
  }, [notes, agents, tasks]);

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
    fg.d3Force("charge")?.strength(-120);
    fg.d3Force("link")?.distance(44);
  }, []);

  // Reheat only when the set of nodes changes (add/remove), so a new node finds
  // its place. Content-only edits don't reheat, so unchanged nodes stay put and
  // the update reads as smooth rather than a full relayout.
  const nodeIdsKey = data.nodes.map((n: any) => n.id).join("|");
  useEffect(() => {
    fgRef.current?.d3ReheatSimulation?.();
  }, [nodeIdsKey]);

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

  // While a node is open the graph is fully occluded by the overlay. Pause its
  // render loop so it stops repainting behind the scrim; otherwise every frame it
  // cools/ticks forces the full-screen backdrop blur to recompute, which janks
  // the open + node-to-node transitions. Resume on close.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    if (selectedId) fg.pauseAnimation?.();
    else fg.resumeAnimation?.();
  }, [selectedId]);

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
      const r = HIT[n.type as GNode["type"]];
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
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={data}
        backgroundColor="#0d1117"
        // Reduced motion: pre-settle off-screen so there's little visible
        // motion, but always keep cooldown ticks so the layout actually runs.
        warmupTicks={REDUCED_MOTION ? 120 : 0}
        cooldownTicks={120}
        d3VelocityDecay={LAYOUT.velocityDecay}
        enableNodeDrag={false}
        enableZoomInteraction={false} // zoom + pan handled by the unified ticker
        enablePanInteraction={false}
        linkColor={() => "rgba(150,176,224,0.12)"}
        nodeCanvasObject={(node: any, ctx, scale) => {
          const sel = node.id === selectedId;
          const hot = node.id === hovered;
          // Entrance driven by the closed-form spring (analytic, O(1) per frame).
          const born = bornAt.current.get(node.id) ?? 0;
          const elapsed = (performance.now() - born) / 1000;
          const p = REDUCED_MOTION ? 1 : springProgress(APPEAR, elapsed);
          const grow = Math.max(0, p);
          const baseR = VIS_R[node.type as GNode["type"]] ?? 3;
          const r = baseR * (0.45 + 0.55 * grow);
          ctx.globalAlpha = p < 0 ? 0 : p > 1 ? 1 : p;
          ctx.beginPath();
          if (node.type === 'artifact') ctx.roundRect(node.x - 7, node.y - 6, 14, 12, 2);
          else ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = COLORS[node.type as GNode["type"]] ?? "#999";
          ctx.fill();
          if (node.type === 'agent') {
            ctx.strokeStyle = '#8eacc2';
            ctx.lineWidth = 1 / scale;
            ctx.stroke();
          }
          if (node.type === 'artifact') {
            ctx.fillStyle = '#0d1117';
            ctx.font = '5px ui-sans-serif, system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(({ pdf: 'PDF', spreadsheet: 'XLS', docx: 'DOC', image: 'IMG', code: '</>' } as Record<string, string>)[node.artifactType] ?? 'FILE', node.x, node.y);
          }
          // Spring-animated ring: scales + fades in/out with carried velocity.
          const selAmt = node.id === ringNode.current.select ? selectRing.current.value : 0;
          const hovAmt = node.id === ringNode.current.hover ? hoverRing.current.value : 0;
          const ring = Math.max(selAmt, hovAmt);
          const entranceAlpha = p < 0 ? 0 : p > 1 ? 1 : p;
          if (ring > 0.002) {
            ctx.globalAlpha = Math.min(1, ring) * entranceAlpha;
            ctx.lineWidth = 2 / scale;
            ctx.strokeStyle = selAmt >= hovAmt ? "#ffffff" : "#2dd4bf";
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 3 * Math.min(1.2, ring), 0, 2 * Math.PI);
            ctx.stroke();
            ctx.globalAlpha = entranceAlpha;
          }
          if (scale > 1.3 || node.type === "note" || node.type === 'agent' || node.type === 'task' || node.type === 'artifact' || sel || hot) {
            ctx.font = `${node.type === "note" ? 5 : 3.6}px ui-sans-serif, system-ui, sans-serif`;
            ctx.fillStyle = sel || hot ? "#ffffff" : "#c9d1d9";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(node.label, node.x, node.y + r + 3);
          }
          ctx.globalAlpha = 1;
        }}
      />
    </div>
  );
}
