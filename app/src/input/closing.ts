import { useDisplay } from '../state/display';
import { useVault } from '../state/store';
import { REDUCED_MOTION } from '../state/hud';

// What "close" means for each kind of window. A window opts in with
// `data-closable="<kind>"`, which is all a gesture needs to know about it.
export const closers: Record<string, () => void> = {
  selection: () => useVault.getState().clear(), // a result or a detail panel
  media: () => useDisplay.getState().close(),
  video: () => useDisplay.getState().closeVideo(),
};

/** Send a window off in the direction it was thrown (px), then close it for real. */
export function throwAway(element: HTMLElement, dx: number, dy: number) {
  const close = closers[element.dataset.closable ?? ''];
  if (!close || element.dataset.leaving) return false;
  if (REDUCED_MOTION) { close(); return true; }
  element.dataset.leaving = 'true';
  const from = getComputedStyle(element).translate;
  const [x = 0, y = 0] = from === 'none' ? [] : from.split(' ').map(parseFloat);
  const flight = element.animate([{ translate: `${x}px ${y}px`, opacity: 1, rotate: '0deg' },
    { translate: `${x + dx}px ${y + dy}px`, opacity: 0, rotate: `${Math.max(-12, Math.min(12, dx / 60))}deg` }], { duration: 260, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
  const done = () => { delete element.dataset.leaving; close(); flight.cancel(); };
  flight.finished.then(done, done);
  return true;
}
