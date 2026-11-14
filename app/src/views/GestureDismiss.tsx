import { useEffect } from 'react';
import { GONE_MS, handDebug, pointerTarget, usePointerStore } from '../input';
import { DismissGesture } from '../input/dismissGesture';
import { subscribeFrame } from '../motion/ticker';
import { useDisplay } from '../state/display';
import { useVault } from '../state/store';
import { REDUCED_MOTION } from '../state/hud';

// Closes what a hand waves away. Windows opt in with `data-closable`; the value
// says what closing means for that window.
const closers: Record<string, () => void> = {
  selection: () => useVault.getState().clear(), // a result or a detail panel
  media: () => useDisplay.getState().close(),
  video: () => useDisplay.getState().closeVideo(),
};
const PALM = [0, 5, 9, 13, 17]; // wrist and knuckles: steadier than a fingertip in a fast move

function throwAway(element: HTMLElement, x: number, y: number, close: () => void) {
  if (element.dataset.leaving) return;
  if (REDUCED_MOTION) { close(); return; }
  // The window leaves the way it was hit, straight away, then closes for real.
  element.dataset.leaving = 'true';
  const flight = element.animate([{ translate: getComputedStyle(element).translate, opacity: 1, rotate: '0deg' },
    { translate: `${x}px ${y}px`, opacity: 0, rotate: `${Math.sign(x) * 10}deg` }], { duration: 240, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' });
  const done = () => { delete element.dataset.leaving; close(); flight.cancel(); };
  flight.finished.then(done, done);
}

/** The window a sweep was aimed at: one it crossed, else the thing on the main stage, else a lone video. */
function target(path: { x: number; y: number }[]) {
  for (const point of path) {
    const hit = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>('[data-closable]');
    if (hit) return hit;
  }
  return document.querySelector<HTMLElement>('[data-closable="media"]') ?? document.querySelector<HTMLElement>('[data-closable="selection"]')
    ?? document.querySelector<HTMLElement>('[data-closable="video"]');
}

export default function GestureDismiss() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  useEffect(() => {
    if (!tracking) return;
    const gesture = new DismissGesture();
    let seen = -1;
    let last = { x: 0, y: 0 };
    return subscribeFrame(now => {
      const present = pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
      // Judge speed on the hand itself, as the camera saw it, not on the cursor:
      // the cursor is smoothed and steadied, which is exactly what hides a slap.
      // The cursor still says where on the screen the hand is.
      const hand = handDebug.hands.find(item => item.primary);
      if (present && hand && handDebug.version === seen) return; // wait for a fresh detection
      seen = handDebug.version;
      if (present && hand) {
        let x = 0, y = 0;
        for (const index of PALM) { x += 1 - hand.pts[index * 2]; y += hand.pts[index * 2 + 1]; }
        last = { x: x / PALM.length * innerWidth, y: y / PALM.length * innerHeight };
      } else if (present) last = { x: pointerTarget.x, y: pointerTarget.y };
      const event = gesture.step(now, { ...last, present, pinching: pointerTarget.pinching }, { width: innerWidth, height: innerHeight });
      if (!event) return;
      if (event.type === 'swipe') {
        // Where the hand was on screen during the sweep: the cursor then and now.
        const element = target([{ x: pointerTarget.x, y: pointerTarget.y }, ...event.path]);
        const close = element && closers[element.dataset.closable ?? ''];
        if (element && close) throwAway(element, event.direction * innerWidth * .9, 0, close);
        return;
      }
      // Hands dropped: clear the stage (a video keeps playing until swiped or closed).
      for (const element of document.querySelectorAll<HTMLElement>('[data-closable="media"], [data-closable="selection"]')) {
        throwAway(element, 0, innerHeight * .7, closers[element.dataset.closable!]);
      }
    });
  }, [tracking]);
  return null;
}
