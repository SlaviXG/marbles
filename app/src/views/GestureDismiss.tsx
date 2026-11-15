import { useEffect } from 'react';
import { GONE_MS, pointerTarget, usePointerStore } from '../input';
import { DismissGesture } from '../input/dismissGesture';
import { throwAway } from '../input/closing';
import { subscribeFrame } from '../motion/ticker';

// Hands dropped out of view: clear the main stage. (Windows are thrown away
// one at a time by pinching and flinging them; that lives in useDragMove.)
export default function GestureDismiss() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  useEffect(() => {
    if (!tracking) return;
    const gesture = new DismissGesture();
    return subscribeFrame(now => {
      const present = usePointerStore.getState().mode === 'hand' && pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
      const event = gesture.step(now, { x: pointerTarget.x, y: pointerTarget.y, present, pinching: pointerTarget.pinching }, { width: innerWidth, height: innerHeight });
      if (!event) return;
      // A video keeps playing: it is a side window, closed by throwing it or by its button.
      for (const element of document.querySelectorAll<HTMLElement>('[data-closable="media"], [data-closable="selection"]')) throwAway(element, 0, innerHeight * .7);
    });
  }, [tracking]);
  return null;
}
