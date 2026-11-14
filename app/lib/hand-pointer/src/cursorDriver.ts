import { SpringValue, springForSettleMs, type Spring } from "./spring";
import { queryMagnet, magnetPull, drainOffset, type MagnetProvider } from "./magnet";
import type { Action } from "./actions";

// The cursor driver: hand state in, cursor + gestures out. It is the step
// between "where the tracked hands are" and "what the user is doing": it
// smooths the fingertip to display rate, keeps the dot continuous through a
// pinch, applies the magnet assist, and recognises press / drag / release and
// the two-handed zoom + pan.
//
// Deliberately free of React, the DOM and the wall clock. Time and hand state
// come in through step(); effects leave through a PointerSink and an action
// emitter. So the same code drives the live cursor, can replay a recorded
// session offline with different params, and can feed any sink an app likes.

// One tracked hand in screen px. cameraPointer's pointerTarget / secondaryHand
// have this shape; `lastSeen` is on the same clock as step()'s `nowMs`.
export interface HandState {
  x: number;
  y: number;
  present: boolean;
  pinching: boolean;
  lastSeen: number;
}

// Where pointer effects land. VirtualPointer (DOM events) satisfies it as is.
export interface PointerSink {
  move(x: number, y: number): void;
  press(x: number, y: number): void;
  release(x: number, y: number): void;
  // Abandon a press without touching hover (a second hand took the gesture).
  cancelPress(x: number, y: number): void;
  // The hand left: lift and drop any hover.
  reset(x?: number, y?: number): void;
}

// All of the driver's feel, as data, so a tuner (or a replay search) can vary
// it without touching the logic.
export interface CursorParams {
  // Settle time of the cursor spring. The tracked point arrives de-jittered but
  // only ~12fps (CPU inference); the spring interpolates it to display rate.
  // Critically damped (no overshoot): an underdamped one would coast past the
  // target between sparse samples, reading as a slide when inference slows.
  settleMs: number;
  // Hand considered absent once unseen for this long (ms).
  goneMs: number;
  // s, time constant of the magnet offset's ease.
  magnetTau: number;
  // Pull fades with cursor speed: full assist when the hand settles onto a
  // target, none in ballistic travel, so a moving cursor tracks the hand 1:1
  // and nothing bends its path mid-flight. px/s.
  magnetSpeedFull: number;
  magnetSpeedOff: number;
  // After a pinch ends, give the hand a beat before assisting again, so
  // releasing a pan does not dart the cursor onto whatever node it stopped
  // near. The offset decays over this pause, which also absorbs the reverse dip
  // as fingers reopen. ms.
  magnetResumeMs: number;
  // Pinch continuity: the dot must never jump at a press. Corrections fold into
  // the same offset the magnet uses; a drag then DRAINS it in proportion to
  // hand travel (this fraction of each px), so a pan blends back to exact 1:1,
  // while a stationary pinch keeps its point and the click lands where the dot
  // shows.
  offsetRecycle: number;
  // The index tip physically dips toward the thumb as a pinch closes (the
  // classic hand-tracking press jump). Anchor the press at the dot's position
  // from this long before the fingers moved (ms), unless the hand is in
  // deliberate travel.
  pinchAnchorMs: number;
  pinchAnchorMaxPx: number; // cap the correction; beyond this trust tracking
  pinchAnchorMaxSpeed: number; // px/s; faster = travelling, do not anchor
  // A press holds the dot exactly where it began until the hand has travelled
  // this far (px). The anchor above corrects only the instant of the press;
  // the hand usually keeps sinking for a few hundred ms after it, and without
  // this the dot slides during the hold and the release misses the target.
  // Past this distance it is a drag, and the dot is released to follow 1:1.
  // 0 turns it off.
  pressHoldPx: number;
  // Two-handed zoom. Gain converts hand separation (px) into a wheel-style
  // delta: ~200px apart is ~2x at the graph's pinch sensitivity.
  zoomGain: number;
  zoomMinDelta: number; // px of separation change worth emitting for
}

// The dot fading in and out as the hand comes and goes: calm, no overshoot.
const FADE: Spring = { zeta: 1, omega: 24 };

export const DEFAULT_CURSOR_PARAMS: CursorParams = {
  settleMs: 110,
  goneMs: 250,
  magnetTau: 0.06,
  magnetSpeedFull: 120,
  magnetSpeedOff: 500,
  magnetResumeMs: 250,
  offsetRecycle: 0.4,
  pinchAnchorMs: 100,
  pinchAnchorMaxPx: 60,
  pinchAnchorMaxSpeed: 250,
  pressHoldPx: 18,
  zoomGain: 0.35,
  zoomMinDelta: 0.5,
};

export interface CursorDriverDeps {
  sink: PointerSink;
  // Semantic actions (zoom, pan) recognised from two hands. See actions.ts.
  emit: (action: Action) => void;
  // Magnet field lookup. Defaults to the registered provider (magnet.ts); pass
  // `() => null` to run with no assist.
  magnet?: MagnetProvider;
  params?: CursorParams;
  // Trace of suppressed press edges, for debugging a click that did not fire.
  debug?: (msg: string) => void;
}

// What to draw this frame. One object, mutated in place and returned from
// step(): read it before the next step, do not hold on to it.
export interface CursorFrame {
  x: number;
  y: number;
  opacity: number;
  // The hand owns the cursor right now (present, and in hand mode).
  active: boolean;
  pressing: boolean;
}

export class CursorDriver {
  private readonly sink: PointerSink;
  private readonly emit: (action: Action) => void;
  private readonly magnet: MagnetProvider;
  private readonly p: CursorParams;
  private readonly debug?: (msg: string) => void;

  private readonly sx: SpringValue;
  private readonly sy: SpringValue;
  private readonly sOpacity: SpringValue;
  private readonly frame: CursorFrame = { x: 0, y: 0, opacity: 0, active: false, pressing: false };

  private wasActive = false;
  private wasPressing = false; // press state last frame
  // Cheap-when-idle gate: skip the sink's hit-test + event dispatch whenever the
  // cursor did not actually move, so a resting hand costs almost nothing on the
  // shared main thread (it is also running the CV pipeline).
  private lastMoveX = NaN; // last position sent to the sink
  private lastMoveY = NaN;
  // The continuity offset, added to the smoothed position. While hovering it is
  // the magnet pull; at a pinch it absorbs the press corrections (kept pull +
  // dip anchor). Invariant: the dot never jumps. Motion drains it, rest decays
  // it.
  private lockedId: string | null = null;
  private offX = 0;
  private offY = 0;
  private lastRawX = NaN; // smoothed position at the last magnet evaluation
  private lastRawY = NaN;
  private magnetRest = false; // offset has settled and the hand is still: skip the scan
  private lastFrameMs = NaN;
  private magnetPauseUntil = 0; // no assist until then (set when a pinch ends)
  private prevX = NaN; // smoothed position last frame, for pinch-drag travel
  private prevY = NaN;
  // Two-handed zoom state. pressLatch keeps the remaining pinched hand from
  // starting a drag the instant the zoom ends: the gesture must be fully let go
  // (both hands unpinched) before a press can begin again.
  private zooming = false;
  private lastZoomDist = 0;
  private lastMidX = 0;
  private lastMidY = 0;
  private pressLatch = false;
  // Dot positions from the last ~250ms, to anchor a press against the pinch dip.
  private readonly hist: { t: number; x: number; y: number }[] = [];
  // Press hold: where the smoothed hand and the dot were when the press began.
  private held = false;
  private pressSx = 0;
  private pressSy = 0;
  private pressDispX = 0;
  private pressDispY = 0;

  constructor(deps: CursorDriverDeps, nowMs: number, startX = 0, startY = 0) {
    this.sink = deps.sink;
    this.emit = deps.emit;
    this.magnet = deps.magnet ?? queryMagnet;
    this.p = deps.params ?? DEFAULT_CURSOR_PARAMS;
    this.debug = deps.debug;
    const spring = springForSettleMs(this.p.settleMs);
    const t = nowMs / 1000;
    this.sx = new SpringValue(spring, startX, t);
    this.sy = new SpringValue(spring, startY, t);
    this.sOpacity = new SpringValue(FADE, 0, t);
  }

  // Advance one display frame. `handMode` false means another source (the real
  // mouse) owns the cursor: the dot hides and nothing is sent to the sink, so
  // there is never a second cursor fighting the first.
  step(nowMs: number, primary: HandState, secondary: HandState, handMode: boolean): CursorFrame {
    const { sx, sy, sOpacity, p, sink } = this;
    const now = nowMs;
    const t = now / 1000;
    const dt = Number.isFinite(this.lastFrameMs)
      ? Math.min(0.05, (now - this.lastFrameMs) / 1000)
      : 1 / 60;
    this.lastFrameMs = now;

    const present = primary.present && now - primary.lastSeen < p.goneMs;
    const active = handMode && present;
    if (active) {
      sx.setTarget(primary.x, t);
      sy.setTarget(primary.y, t);
    }
    sOpacity.setTarget(active ? 1 : 0, t);
    sx.update(t);
    sy.update(t);
    sOpacity.update(t);

    // Named for what it means rather than for the fingers that produced it:
    // nothing below this line cares how the press was made.
    const pressing = active && primary.pinching;

    // Two-handed pinch-to-zoom. Both hands pinched: the distance between them
    // drives zoom, apart to go in, together to go out. Emitted as a semantic
    // action, not aimed at any view, so whatever surface is in front claims it.
    const secondLive = secondary.present && now - secondary.lastSeen < p.goneMs;
    const bothPinch = active && primary.pinching && secondLive && secondary.pinching;
    if (bothPinch) {
      const dist = Math.hypot(primary.x - secondary.x, primary.y - secondary.y);
      if (!this.zooming) {
        // Whichever hand pinched first already pressed, and that press would
        // drag the surface while the other hand zooms it. Cancel just the press
        // and latch it off until the whole gesture is released. Deliberately
        // NOT reset(): that would also drop the hover, which a hover-dismissed
        // surface reads as the pointer leaving, closing the very note the zoom
        // is meant to act on.
        sink.cancelPress(sx.value + this.offX, sy.value + this.offY);
        this.lastMoveX = NaN;
        this.lastMoveY = NaN;
        this.zooming = true;
        this.pressLatch = true;
        this.lastZoomDist = dist;
        this.lastMidX = (primary.x + secondary.x) / 2;
        this.lastMidY = (primary.y + secondary.y) / 2;
      } else {
        // The midpoint is the anchor for both halves of the gesture: it is what
        // a two-point pinch on a touchscreen holds fixed, and it is the one
        // point that belongs to neither hand, so neither hand's tremor steers
        // it alone. Separation drives zoom, the midpoint moving drives pan, and
        // emitting both lets you zoom and navigate in one motion.
        const midX = (primary.x + secondary.x) / 2;
        const midY = (primary.y + secondary.y) / 2;
        const d = dist - this.lastZoomDist;
        if (Math.abs(d) >= p.zoomMinDelta) {
          this.emit({
            type: "zoom",
            delta: -d * p.zoomGain, // hands apart -> negative delta -> zoom in
            x: midX,
            y: midY,
            pinch: true,
          });
          this.lastZoomDist = dist;
        }
        const mdx = midX - this.lastMidX;
        const mdy = midY - this.lastMidY;
        if (Math.hypot(mdx, mdy) >= p.zoomMinDelta) {
          this.emit({ type: "pan", dx: mdx, dy: mdy });
          this.lastMidX = midX;
          this.lastMidY = midY;
        }
      }
    } else if (this.zooming) {
      this.zooming = false;
    }
    // Only a real release clears the latch, so ending the zoom with one hand
    // still pinched does not immediately start a drag with it.
    if (this.pressLatch && !primary.pinching) this.pressLatch = false;

    // Pinch transitions. Continuity rule: the dot never jumps at a press or a
    // release. Corrections fold into the offset, which travel drains (below)
    // and rest decays (the evaluation branch).
    if (pressing && !this.wasPressing) {
      // Pinch begins: press where the dot shows, not where tracking landed.
      // Anchoring to the dot's position pinchAnchorMs ago keeps any magnet pull
      // (no snap) AND cancels the pinch dip in one move. Skipped in deliberate
      // travel, where an anchor would lag the motion.
      const speed = Math.hypot(sx.velocity, sy.velocity);
      const hist = this.hist;
      if (speed < p.pinchAnchorMaxSpeed && hist.length) {
        let a = hist[0];
        for (let i = hist.length - 1; i >= 0; i--) {
          if (now - hist[i].t >= p.pinchAnchorMs) {
            a = hist[i];
            break;
          }
        }
        let nx = a.x - sx.value;
        let ny = a.y - sy.value;
        const len = Math.hypot(nx, ny);
        if (len > p.pinchAnchorMaxPx) {
          nx *= p.pinchAnchorMaxPx / len;
          ny *= p.pinchAnchorMaxPx / len;
        }
        this.offX = nx;
        this.offY = ny;
      }
      this.lockedId = null; // no pull while pinched
      this.magnetRest = false;
      this.held = p.pressHoldPx > 0;
      this.pressSx = sx.value;
      this.pressSy = sy.value;
      this.pressDispX = sx.value + this.offX;
      this.pressDispY = sy.value + this.offY;
    } else if (!pressing && this.wasPressing) {
      this.held = false;
      // Pinch ended: pause the assist so releasing a pan does not dart the
      // cursor onto a nearby node; the decay below eases out any residue.
      this.magnetPauseUntil = now + p.magnetResumeMs;
    }
    if (
      active &&
      pressing &&
      this.held &&
      Math.hypot(sx.value - this.pressSx, sy.value - this.pressSy) < p.pressHoldPx
    ) {
      // Still within the hold: pin the dot to the press point by absorbing
      // whatever the hand has drifted into the offset. If the hold breaks
      // later, that offset is what the drain below works off, so the dot
      // starts moving from the press point without a jump.
      this.offX = this.pressDispX - sx.value;
      this.offY = this.pressDispY - sy.value;
    } else if (active && pressing) {
      this.held = false;
      // A drag drains the offset in proportion to travel, blending the pan back
      // to exact 1:1; a stationary pinch keeps its point for the click.
      const travel = Number.isFinite(this.prevX)
        ? Math.hypot(sx.value - this.prevX, sy.value - this.prevY)
        : 0;
      if (travel > 0 && (this.offX !== 0 || this.offY !== 0)) {
        const d = drainOffset(this.offX, this.offY, travel * p.offsetRecycle);
        this.offX = d.x;
        this.offY = d.y;
      }
    }
    // Magnet pull, only while hovering free (a pinch gets no assist). Pull fades
    // with cursor speed (assist on settle, never in flight); the provider
    // handles validity (occlusion, node-open). Gated behind real movement (plus
    // a settle tail) so a resting hand skips the scan.
    if (active && !pressing) {
      const rawStill =
        Number.isFinite(this.lastRawX) &&
        Math.hypot(sx.value - this.lastRawX, sy.value - this.lastRawY) < 0.1;
      if (!(rawStill && this.magnetRest)) {
        const m =
          now < this.magnetPauseUntil ? null : this.magnet(sx.value, sy.value, this.lockedId);
        let tgtX = 0;
        let tgtY = 0;
        this.lockedId = null;
        if (m) {
          const d = Math.hypot(sx.value - m.x, sy.value - m.y);
          const speed = Math.hypot(sx.velocity, sy.velocity);
          // magnetPull is a smoothstep ramp; reused to fade the pull out as
          // speed rises from magnetSpeedFull toward magnetSpeedOff.
          const w =
            magnetPull(d, m.capture, m.lock) *
            magnetPull(speed, p.magnetSpeedOff, p.magnetSpeedFull);
          if (w > 0.15) this.lockedId = m.id; // hysteresis only for a real grip
          tgtX = (m.x - sx.value) * w;
          tgtY = (m.y - sy.value) * w;
        }
        const ease = 1 - Math.exp(-dt / p.magnetTau); // time-based, framerate-proof
        this.offX += (tgtX - this.offX) * ease;
        this.offY += (tgtY - this.offY) * ease;
        this.magnetRest = Math.hypot(tgtX - this.offX, tgtY - this.offY) < 0.1;
        this.lastRawX = sx.value;
        this.lastRawY = sy.value;
      }
    }
    const dispX = active ? sx.value + this.offX : sx.value;
    const dispY = active ? sy.value + this.offY : sy.value;

    // Drive the sink from the warped position, but only send a move when it
    // actually moved: the sink's hit-test + event dispatch (and the hover work
    // it triggers) are the pipeline's real per-frame cost and are pointless
    // while the cursor holds still.
    if (active && !this.zooming) {
      const moved =
        !Number.isFinite(this.lastMoveX) ||
        Math.hypot(dispX - this.lastMoveX, dispY - this.lastMoveY) > 0.3;
      if (moved) {
        sink.move(dispX, dispY);
        this.lastMoveX = dispX;
        this.lastMoveY = dispY;
      }
      if (pressing && !this.wasPressing && !this.pressLatch) {
        sink.press(dispX, dispY); // press() re-targets to the element itself
        this.lastMoveX = dispX;
        this.lastMoveY = dispY;
      } else if (!pressing && this.wasPressing) {
        sink.release(dispX, dispY);
      }
    } else if (this.wasActive && !this.zooming) {
      sink.reset(dispX, dispY);
      this.lastMoveX = NaN;
      this.lastMoveY = NaN;
      this.offX = 0;
      this.offY = 0;
      this.lockedId = null;
      this.magnetRest = false;
      this.lastRawX = NaN;
      this.lastRawY = NaN;
      this.magnetPauseUntil = 0;
      this.hist.length = 0;
      this.zooming = false;
      this.pressLatch = false;
      this.held = false;
    }
    // Bookkeeping for the pinch anchor (dot history) and drag travel.
    if (active && !pressing) {
      this.hist.push({ t: now, x: dispX, y: dispY });
      while (this.hist.length && now - this.hist[0].t > 250) this.hist.shift();
    }
    this.prevX = sx.value;
    this.prevY = sy.value;
    if (this.debug) {
      if (pressing !== this.wasPressing && this.zooming)
        this.debug("press edge SUPPRESSED: in two-handed zoom mode");
      if (pressing && !this.wasPressing && this.pressLatch)
        this.debug("press edge SUPPRESSED: pressLatch held");
    }
    this.wasActive = active;
    this.wasPressing = pressing;

    const f = this.frame;
    f.x = dispX;
    f.y = dispY;
    f.opacity = sOpacity.value;
    f.active = active;
    f.pressing = pressing;
    return f;
  }
}
