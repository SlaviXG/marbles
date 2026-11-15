import { useEffect, useRef } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { clickSlop, steady, usePointerStore } from '../input';
import { throwAway } from '../input/closing';

// Pinch a window and fling it: let go while it is still moving fast and it
// keeps going, off the screen, and closes. Set down gently, it just stays where
// you put it. A grip is required, so a hand that is merely waving closes nothing.
export const FLING = {
  speed: 1500, // px/s at the moment of release
  travel: 140, // the drag must have covered at least this much, so a twitch on release is not a throw
  sampleMs: 140, // speed is averaged over this long before release (the pinch opening jolts the last frames)
};

// Pick a window up by its title bar and put it somewhere else. Works for the
// mouse and for a pinch-and-move, because the camera cursor's synthetic pointer
// events bubble to the same window-level listeners.
//
// The offset is written to the CSS `translate` property, which composes with
// (and never overwrites) the `transform` that open/close animations drive.
const KEEP = 96; // px of the window that must stay on screen, so it can always be grabbed back

export function useDragMove<T extends HTMLElement, H extends HTMLElement>(
  target: RefObject<T | null>, handle: RefObject<H | null>, resetKey: unknown = null,
): MutableRefObject<{ x: number; y: number }> {
  const offset = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const element = target.current;
    const grip = handle.current;
    if (!element || !grip) return;
    offset.current = { x: 0, y: 0 };
    element.style.translate = '';
    let start = { x: 0, y: 0 }, origin = { x: 0, y: 0 }, home = { left: 0, top: 0, width: 0, height: 0 };
    let active = false, moved = false;
    let trail: { t: number; x: number; y: number }[] = [];
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as Element).closest('button, a, input, select, textarea, [data-no-drag]')) return;
      const rect = element.getBoundingClientRect();
      home = { left: rect.left - offset.current.x, top: rect.top - offset.current.y, width: rect.width, height: rect.height };
      start = { x: event.clientX, y: event.clientY }; origin = { ...offset.current };
      active = true; moved = false; trail = [{ t: performance.now(), x: event.clientX, y: event.clientY }];
    };
    const move = (event: PointerEvent) => {
      if (!active) return;
      // While the hand drives the cursor, a trusted move is not the user's grab.
      if (event.isTrusted && usePointerStore.getState().mode === 'hand' && usePointerStore.getState().status === 'tracking') return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < clickSlop(5)) return;
      // The cursor must track the hand exactly while it carries something.
      if (!moved) { moved = true; element.classList.add('window-dragging'); steady.drag(true); }
      const x = Math.max(KEEP - home.left - home.width, Math.min(innerWidth - KEEP - home.left, origin.x + dx));
      const y = Math.max(-home.top, Math.min(innerHeight - KEEP - home.top, origin.y + dy));
      offset.current = { x, y };
      element.style.translate = `${x}px ${y}px`;
      const now = performance.now();
      trail.push({ t: now, x: event.clientX, y: event.clientY });
      while (trail.length > 2 && now - trail[0].t > 400) trail.shift();
    };
    const up = () => {
      if (!active) return;
      active = false; element.classList.remove('window-dragging');
      if (!moved) return;
      steady.drag(false);
      // Was it thrown? Speed just before release, ignoring the last jolt of the pinch opening.
      const last = trail[trail.length - 1];
      const from = trail.find(point => last.t - point.t <= FLING.sampleMs) ?? trail[0];
      const seconds = Math.max(.016, (last.t - from.t) / 1000);
      const vx = (last.x - from.x) / seconds, vy = (last.y - from.y) / seconds;
      const travelled = Math.hypot(last.x - start.x, last.y - start.y);
      if (performance.now() - last.t < 120 && Math.hypot(vx, vy) >= FLING.speed && travelled >= FLING.travel && element.dataset.closable) {
        const reach = Math.max(innerWidth, innerHeight) * .9 / Math.hypot(vx, vy);
        throwAway(element, vx * reach, vy * reach);
      }
    };
    grip.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      grip.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      element.classList.remove('window-dragging');
      if (active && moved) steady.drag(false);
    };
  }, [target, handle, resetKey]);
  return offset;
}
