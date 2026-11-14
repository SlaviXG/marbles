import { useEffect } from 'react';
import { GONE_MS, pointerTarget, usePointerStore } from '../input';
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

function throwAway(element: HTMLElement, x: number, y: number, close: () => void) {
  if (REDUCED_MOTION) { close(); return; }
  // The window leaves the way it was hit, then closes for real.
  const flight = element.animate([{ translate: getComputedStyle(element).translate, opacity: 1, rotate: '0deg' },
    { translate: `${x}px ${y}px`, opacity: 0, rotate: `${Math.sign(x) * 8}deg` }], { duration: 260, easing: 'cubic-bezier(.3,0,.8,.3)', fill: 'forwards' });
  flight.finished.then(() => { close(); flight.cancel(); }, () => close());
}

export default function GestureDismiss() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  useEffect(() => {
    if (!tracking) return;
    const gesture = new DismissGesture();
    return subscribeFrame(now => {
      const hand = usePointerStore.getState().mode === 'hand';
      const present = hand && pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
      const event = gesture.step(now, { x: pointerTarget.x, y: pointerTarget.y, present, pinching: pointerTarget.pinching }, { width: innerWidth, height: innerHeight });
      if (!event) return;
      if (event.type === 'swipe') {
        // Only what the hand was actually on when the sweep began.
        const target = document.elementFromPoint(event.x, event.y)?.closest<HTMLElement>('[data-closable]');
        const close = target && closers[target.dataset.closable ?? ''];
        if (target && close) throwAway(target, event.direction * innerWidth * .9, 0, close);
        return;
      }
      // Hands dropped: clear the stage (a video keeps playing until swiped or closed).
      for (const element of document.querySelectorAll<HTMLElement>('[data-closable="media"], [data-closable="selection"]')) {
        const close = closers[element.dataset.closable!];
        throwAway(element, 0, innerHeight * .7, close);
      }
    });
  }, [tracking]);
  return null;
}
