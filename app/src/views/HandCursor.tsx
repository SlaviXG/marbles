import { useEffect, useRef } from "react";
import { subscribeFrame } from "../motion/ticker";
import {
  CursorDriver,
  handCursorPosition,
  VirtualPointer,
  dispatchAction,
  pointerTarget,
  secondaryHand,
  usePointerStore,
  type PointerSink,
} from "../input";

// The camera cursor: a soft luminous dot that follows the index fingertip. This
// view only draws and wires. What the dot does (smoothing, magnet, press, drag,
// two-handed zoom) is decided by the CursorDriver in input/; here its output is
// written straight to the DOM in the shared ticker, so following the hand never
// triggers a React render, and its pointer effects are sent into the page as
// synthetic DOM events (VirtualPointer) and semantic actions (dispatchAction).

// Visit /?debug to trace the press path in the console (matches GraphView).
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("debug");

// Log each press and release with what was under it, then pass it on.
function traced(vp: VirtualPointer): PointerSink {
  return {
    move: (x, y) => vp.move(x, y),
    cancelPress: (x, y) => vp.cancelPress(x, y),
    reset: (x, y) => vp.reset(x, y),
    press: (x, y) => {
      console.debug(
        `[cursor] press at ${x.toFixed(0)},${y.toFixed(0)} under=`,
        document.elementFromPoint(x, y),
      );
      vp.press(x, y);
    },
    release: (x, y) => {
      console.debug(`[cursor] release at ${x.toFixed(0)},${y.toFixed(0)}`);
      vp.release(x, y);
    },
  };
}

export default function HandCursor() {
  const status = usePointerStore((s) => s.status);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== "tracking") return;
    const el = ref.current;
    if (!el) return;

    const vp = new VirtualPointer();
    const driver = new CursorDriver(
      {
        sink: DEBUG ? traced(vp) : vp,
        emit: dispatchAction,
        debug: DEBUG ? (msg) => console.debug(`[cursor] ${msg}`) : undefined,
      },
      performance.now(),
      pointerTarget.x,
      pointerTarget.y,
    );
    // Write transform/opacity only when they actually moved (a settled cursor
    // re-writes nothing).
    let lastTx = NaN;
    let lastTy = NaN;
    let lastOp = -1;
    let wasPressing = false;

    const unsub = subscribeFrame((now) => {
      const handMode = usePointerStore.getState().mode === "hand";
      const f = driver.step(now, pointerTarget, secondaryHand, handMode);
      handCursorPosition.x = f.x; handCursorPosition.y = f.y;
      if (!Number.isFinite(lastTx) || Math.abs(f.x - lastTx) > 0.05 || Math.abs(f.y - lastTy) > 0.05) {
        el.style.transform = `translate3d(${f.x}px, ${f.y}px, 0)`;
        lastTx = f.x;
        lastTy = f.y;
      }
      if (Math.abs(f.opacity - lastOp) > 0.004) {
        el.style.opacity = String(f.opacity);
        lastOp = f.opacity;
      }
      if (f.pressing !== wasPressing) {
        el.classList.toggle("pinch", f.pressing);
        wasPressing = f.pressing;
      }
    });

    return () => {
      unsub();
      vp.reset();
    };
  }, [status]);

  if (status !== "tracking") return null;
  return (
    <div className="hand-cursor" ref={ref} aria-hidden>
      <div className="hand-cursor-ring" />
      <div className="hand-cursor-ripple" />
      <div className="hand-cursor-dot" />
    </div>
  );
}
