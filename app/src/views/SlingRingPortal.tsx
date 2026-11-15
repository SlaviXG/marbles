import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { GONE_MS, handDebug, pointerTarget, secondaryHand, steady, usePointerStore } from '../input';
import { PortalGesture } from '../input/portalGesture';
import { subscribeFrame } from '../motion/ticker';
import './sling-ring-portal.css';

const CAMEO_MS = 5200;
const PREVIEW_EVENT = 'marbles:preview-portal';
export function previewPortal() { window.dispatchEvent(new Event(PREVIEW_EVENT)); }

export default function SlingRingPortal() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  const [cameo, setCameo] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const quietUntil = useRef(0);

  useEffect(() => {
    const gesture = new PortalGesture();
    let timer = 0;
    let version = -1;
    const summon = () => {
      const now = performance.now();
      if (now < quietUntil.current || document.hidden) return;
      quietUntil.current = now + 8000;
      gesture.reset();
      setImageFailed(false);
      setCameo(true);
      timer = window.setTimeout(() => setCameo(false), CAMEO_MS);
    };
    const reset = () => gesture.reset();
    const stop = tracking ? subscribeFrame(now => {
      if (document.hidden || usePointerStore.getState().mode !== 'hand' || now < quietUntil.current) { reset(); return; }
      if (version === handDebug.version) return;
      version = handDebug.version;
      const hand = handDebug.hands.find(h => h.primary && h.active);
      const secondPinching = secondaryHand.present && now - secondaryHand.lastSeen <= GONE_MS && secondaryHand.pinching;
      if (gesture.step(now, {
        x: hand ? 1 - hand.pts[16] : 0, y: hand?.pts[17] ?? 0, hand: hand?.hand ?? '',
        present: !!hand && pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS,
        blocked: pointerTarget.pinching || secondPinching || steady.dragging,
      })) summon();
    }) : () => {};
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { window.clearTimeout(timer); setCameo(false); reset(); }
    };
    window.addEventListener(PREVIEW_EVENT, summon);
    window.addEventListener('keydown', escape);
    document.addEventListener('visibilitychange', reset);
    return () => {
      stop(); window.clearTimeout(timer); setCameo(false);
      window.removeEventListener(PREVIEW_EVENT, summon);
      window.removeEventListener('keydown', escape);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [tracking]);

  return <div className="sling-ring-layer" role="status" aria-live="polite" aria-atomic="true">
    {cameo && <div className="sling-ring-cameo">
      <div className="sling-ring-scene" aria-hidden="true">
        <div className="sling-ring-door" />
        {!imageFailed && <img className="sling-ring-spiderman" src="/images/portal-spiderman.jpg" alt="" onError={() => setImageFailed(true)} />}
        <div className="sling-ring-rim" />
        <div className="sling-ring-sparks">{Array.from({ length: 64 }, (_, i) => <i key={i} style={{
          '--angle': `${i * 137.508}deg`, '--reach': `${18 + i % 7 * 7}px`,
          '--delay': `${-(i % 11) * .13}s`, '--speed': `${.55 + (i % 5) * .13}s`,
        } as CSSProperties} />)}</div>
      </div>
      <p className="sling-ring-caption">{imageFailed ? 'A visitor from the multiverse.' : 'Andrew Garfield’s Spider-Man steps through the portal.'}</p>
    </div>}
  </div>;
}
