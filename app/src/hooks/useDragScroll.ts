import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import { subscribeFrame } from "../motion/ticker";
import { SpringValue } from "../motion/SpringValue";
import { clickSlop, usePointerStore } from "../input";

// Live drag state, exposed so the panel can tell a real hover-out from the tail
// of a scroll-drag: a drag that starts inside the content and ends out in the
// close/exit area must NOT close the node.
export interface DragScrollState {
  dragging: boolean; // a scroll-drag is in progress right now
  endedAt: number; // performance.now() when the last drag ended
}

// Drag-to-scroll for the immersive content: press and drag moves the content
// vertically, like a touch surface, and a flick releases into a spring glide.
// Works for the real mouse AND the camera cursor (a pinch presses; moving the
// hand drags) because VirtualPointer's synthetic pointer events bubble, so the
// window-level move/up listeners catch both kinds.
//
// Drag vs click is decided by MOVEMENT, not by what was pressed: a press on a
// link or button is fine; once it moves past the threshold it becomes a scroll
// (and the trailing click is swallowed), while a tap still clicks. Only controls
// that own their own drag (the video scrubber) opt out.
const DRAG_THRESHOLD = 6; // px of vertical travel before a press becomes a drag
const FLING_MIN = 60; // px/s release speed below which we just stop (no glide)
const COAST = 0.15; // seconds of projected travel the release velocity buys

// The only things that keep their own press/drag. Ordinary links and buttons do
// NOT opt out: a tap clicks them, a drag scrolls past them.
const NO_DRAG = "input[type='range'], [role='slider'], [data-no-dragscroll]";

export function useDragScroll<T extends HTMLElement>(
  ref: RefObject<T | null>,
): MutableRefObject<DragScrollState> {
  const stateRef = useRef<DragScrollState>({ dragging: false, endedAt: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const state = stateRef.current;

    // One reused spring for the release glide, advanced by the shared ticker.
    const fling = new SpringValue("calm", 0);
    let flingStop: (() => void) | null = null;
    const stopFling = () => {
      flingStop?.();
      flingStop = null;
    };

    let startY = 0;
    let startTop = 0;
    let active = false; // a press is down and eligible to become a drag
    let dragging = false; // moved past the threshold
    let lastTop = 0;
    let lastT = 0;
    let vel = 0; // scrollTop px/s, smoothed, for the release fling

    const maxTop = () => el.scrollHeight - el.clientHeight;

    // The user is selecting text inside the content: a live, non-collapsed
    // selection anchored in our scroller. A real mouse dragging over text grows
    // this selection; the synthetic camera-cursor events (isTrusted:false) do
    // not, so this also keeps drag-to-scroll working for the hand cursor.
    const isSelectingText = () => {
      const sel = window.getSelection();
      return (
        !!sel &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        sel.anchorNode != null &&
        el.contains(sel.anchorNode)
      );
    };

    const onMove = (e: PointerEvent) => {
      if (!active) return;
      // While the hand owns the cursor, a real trusted pointermove here is not a
      // genuine grab (that would have already flipped the shared pointer mode to
      // "mouse", cameraPointer's listener runs first) — it is WebKit's synthetic
      // re-hover at the stationary real OS pointer position, fired when content
      // scrolls underneath it. Following its coordinates would snap the drag to
      // that unrelated position instead of the hand's. Ignore it.
      if (e.isTrusted && usePointerStore.getState().mode === "hand") return;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < clickSlop(DRAG_THRESHOLD)) return;
        // Selecting text wins over scrolling: when a horizontal selection wraps
        // to the next line the vertical travel would otherwise trip the drag
        // threshold. Yield and let native selection continue.
        if (isSelectingText()) {
          active = false;
          return;
        }
        // Re-anchor at the threshold crossing so the content doesn't jump by the
        // threshold distance when the drag engages.
        dragging = true;
        state.dragging = true;
        el.classList.add("dragging");
        startY = e.clientY;
        startTop = el.scrollTop;
        lastTop = el.scrollTop;
        lastT = performance.now();
        return;
      }
      // Natural (touch) direction: drag down reveals content above.
      el.scrollTop = startTop - (e.clientY - startY);
      const now = performance.now();
      const dt = Math.max(1, now - lastT) / 1000;
      const inst = (el.scrollTop - lastTop) / dt;
      vel = vel * 0.6 + inst * 0.4; // smooth so a final stutter doesn't kill the fling
      lastTop = el.scrollTop;
      lastT = now;
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      if (dragging) {
        // Swallow the click that would otherwise fire on the element the drag
        // began on, so a drag that starts on a link does not also navigate. (The
        // camera cursor emits no click after a drag; the timeout drops the unused
        // trap.)
        const swallow = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, true), 0);
        // Spring momentum: glide to a projected target and settle, carrying the
        // release velocity so there's no restart discontinuity.
        if (Math.abs(vel) > FLING_MIN) {
          const target = Math.max(0, Math.min(maxTop(), el.scrollTop + vel * COAST));
          fling.jump(el.scrollTop);
          fling.setTarget(target, vel);
          flingStop = subscribeFrame((nowMs) => {
            const settled = fling.update(nowMs / 1000);
            el.scrollTop = fling.value;
            if (settled) stopFling();
          });
        }
      }
      if (dragging) state.endedAt = performance.now();
      active = false;
      dragging = false;
      state.dragging = false;
      el.classList.remove("dragging");
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element | null;
      if (target?.closest(NO_DRAG)) return; // the scrubber keeps its own drag
      stopFling(); // a new grab cancels any in-flight glide
      active = true;
      dragging = false;
      vel = 0;
      startY = e.clientY;
      startTop = el.scrollTop;
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
    };

    el.addEventListener("pointerdown", onDown);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      stopFling();
    };
  }, [ref]);

  return stateRef;
}
