import { cameraPointer, pointerStore, pointerTarget, secondaryHand, type StartOptions } from "./cameraPointer";
import { CursorDriver, type CursorParams } from "./cursorDriver";
import { VirtualPointer } from "./virtualPointer";
import { dispatchAction } from "./actions";

// The one-call entry: camera on, a dot that follows the fingertip, and the page
// driven by ordinary pointer events (a pinch is a press). No framework needed.
//
// It is a thin composition of the public pieces (cameraPointer, CursorDriver,
// VirtualPointer, dispatchAction). An app that wants its own cursor element or
// its own frame loop wires those itself instead of calling this.

export interface HandPointerOptions extends StartOptions {
  // Tuning for the cursor's feel. Defaults to DEFAULT_CURSOR_PARAMS.
  params?: CursorParams;
  // Dot colour (any CSS colour). Default teal.
  color?: string;
  // Hide the native mouse cursor while the hand owns the pointer. Default true.
  hideNativeCursor?: boolean;
}

const ACTIVE_CLASS = "hand-pointer-active";

// Starts tracking and returns a function that stops it and removes everything
// it added. Resolves once the camera is granted (or has failed: check
// pointerStore.getState().status).
export async function startHandPointer(options: HandPointerOptions = {}): Promise<() => void> {
  const color = options.color ?? "#2dd4bf";
  const hideNative = options.hideNativeCursor ?? true;

  // Outer element is moved by transform every frame; the inner dot eases its
  // own press animation, so the two never fight over one transform.
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText =
    "position:fixed;top:0;left:0;z-index:2147483647;pointer-events:none;opacity:0;will-change:transform,opacity";
  const dot = document.createElement("div");
  dot.style.cssText =
    `width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;` +
    `background:radial-gradient(circle at 50% 50%,#fff 0%,${color} 45%,transparent 72%);` +
    `box-shadow:0 0 10px ${color},0 0 24px ${color};transition:transform 90ms ease`;
  el.appendChild(dot);
  document.body.appendChild(el);

  const style = document.createElement("style");
  style.textContent = `.${ACTIVE_CLASS},.${ACTIVE_CLASS} *{cursor:none !important}`;
  if (hideNative) document.head.appendChild(style);

  const vp = new VirtualPointer();
  let driver: CursorDriver | null = null;
  let raf = 0;
  let lastX = NaN;
  let lastY = NaN;
  let lastOpacity = -1;
  let wasPressing = false;
  let wasOwning = false;

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const { status, mode } = pointerStore.getState();
    if (status !== "tracking") return;
    // Created on the first tracked frame, so the spring starts where the hand is.
    driver ??= new CursorDriver(
      { sink: vp, emit: dispatchAction, params: options.params },
      now,
      pointerTarget.x,
      pointerTarget.y,
    );
    const f = driver.step(now, pointerTarget, secondaryHand, mode === "hand");
    // Write only what changed: a resting hand costs no style work.
    if (!(Math.abs(f.x - lastX) <= 0.05 && Math.abs(f.y - lastY) <= 0.05)) {
      el.style.transform = `translate3d(${f.x}px,${f.y}px,0)`;
      lastX = f.x;
      lastY = f.y;
    }
    if (Math.abs(f.opacity - lastOpacity) > 0.004) {
      el.style.opacity = String(f.opacity);
      lastOpacity = f.opacity;
    }
    if (f.pressing !== wasPressing) {
      dot.style.transform = f.pressing ? "scale(0.6)" : "";
      wasPressing = f.pressing;
    }
    const owning = mode === "hand";
    if (owning !== wasOwning) {
      document.documentElement.classList.toggle(ACTIVE_CLASS, owning);
      wasOwning = owning;
    }
  };

  await cameraPointer.start(options);
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    cameraPointer.stop();
    vp.reset();
    document.documentElement.classList.remove(ACTIVE_CLASS);
    style.remove();
    el.remove();
  };
}
