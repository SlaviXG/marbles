import { useEffect } from 'react';
import { GONE_MS, handDebug, handCursorPosition, pointerTarget, secondaryHand, steady, usePointerStore } from '../input';
import { DismissGesture, openPalm } from '../input/dismissGesture';
import { throwAway } from '../input/closing';
import { subscribeFrame } from '../motion/ticker';

// A deliberate open-palm swish closes the aimed window, including video.
// Dropping hands out of view clears the main stage. Pinch-and-fling also works.
export default function GestureDismiss() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  useEffect(() => {
    if (!tracking) return;
    const gesture = new DismissGesture();
    const visibleWindow = (kind: string) => Array.from(document.querySelectorAll<HTMLElement>(`[data-closable="${kind}"]`)).find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]')) ?? null;
    let highlighted: HTMLElement | null = null;
    const stop = subscribeFrame(now => {
      const primary = handDebug.hands.find(hand => hand.active && hand.primary);
      const present = !!primary && usePointerStore.getState().mode === 'hand' && pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
      const hit = document.elementFromPoint(handCursorPosition.x, handCursorPosition.y)?.closest<HTMLElement>('[data-closable]');
      const event = gesture.step(now, { x: pointerTarget.x, y: pointerTarget.y, present,
        pinching: pointerTarget.pinching || (secondaryHand.present && now - secondaryHand.lastSeen <= GONE_MS && secondaryHand.pinching) || steady.dragging,
        open: !!primary && openPalm(primary.pts), target: hit?.dataset.closable }, { width: innerWidth, height: innerHeight });
      const armed = gesture.armedTarget ? visibleWindow(gesture.armedTarget) : null;
      if (armed !== highlighted) { highlighted?.classList.remove('swish-ready'); armed?.classList.add('swish-ready'); highlighted = armed; }
      if (!event) return;
      if (event.type === 'swipe') {
        const element = visibleWindow(event.target);
        if (element) throwAway(element, event.direction * innerWidth * .9, 0);
        return;
      }
      // A video keeps playing: it is a side window, closed by throwing it or by its button.
      for (const element of document.querySelectorAll<HTMLElement>('[data-closable="media"], [data-closable="selection"]')) throwAway(element, 0, innerHeight * .7);
    });
    return () => { stop(); highlighted?.classList.remove('swish-ready'); };
  }, [tracking]);
  return null;
}
