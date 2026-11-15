import { useEffect, useRef, useState } from 'react';
import { GONE_MS, handDebug, pointerTarget, secondaryHand, steady, usePointerStore } from '../input';
import { PORTAL, PortalGesture } from '../input/portalGesture';
import { SlingRingEffect, type PortalPhase } from '../effects/SlingRingEffect';
import { subscribeFrame } from '../motion/ticker';
import './sling-ring-portal.css';

const PREVIEW_EVENT = 'marbles:preview-portal';
export function previewPortal() { window.dispatchEvent(new Event(PREVIEW_EVENT)); }

export default function SlingRingPortal() {
  const tracking = usePointerStore(s => s.status === 'tracking');
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<PortalPhase>('idle');
  const [armed, setArmed] = useState(false);
  const quietUntil = useRef(0);

  useEffect(() => {
    if (!canvas.current?.getContext('2d')) return;
    const effect = new SlingRingEffect(canvas.current, setPhase);
    const gesture = new PortalGesture();
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    effect.reduced = motion.matches;
    let stop: (() => void) | null = null;
    let version = -1;
    let wasArmed = false;
    let runningCameo = false;

    const updateArmed = () => {
      if (wasArmed !== gesture.armed) { wasArmed = gesture.armed; setArmed(wasArmed); }
    };
    const reset = () => { gesture.reset(); updateArmed(); };
    const summon = (preview: boolean, circle = gesture.trail) => {
      const now = performance.now();
      if (document.hidden || runningCameo || (!preview && now < quietUntil.current)) return;
      quietUntil.current = now + PORTAL.cooldownMs;
      effect.summon(now, preview ? undefined : circle);
      runningCameo = true;
      reset(); ensureRunning();
    };
    const frame = (now: number) => {
      if (document.hidden) return;
      if (tracking && !runningCameo && now >= quietUntil.current) {
        const hand = handDebug.hands.find(h => h.primary && h.active);
        const present = !!hand && usePointerStore.getState().mode === 'hand' && pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
        const blocked = pointerTarget.pinching || steady.dragging
          || (secondaryHand.present && now - secondaryHand.lastSeen <= GONE_MS && secondaryHand.pinching);
        // Let the recognizer tolerate a brief blur, but cancel pinches and
        // mouse takeover immediately. No missing frame contributes movement.
        if (blocked || usePointerStore.getState().mode !== 'hand') reset();
        else if (!present) {
          gesture.step(now, { x: 0, y: 0, hand: '', present: false, blocked: false });
          updateArmed();
        }
        else if (hand && version !== handDebug.version) {
          version = handDebug.version;
          const circle = gesture.trail;
          const complete = gesture.step(now, { x: 1 - hand.pts[16], y: hand.pts[17], hand: hand.hand, present, blocked });
          if (complete) summon(false, circle);
          // A substantial circular arc lights a guiding trail before closure.
          else if (gesture.armed) effect.trace(gesture.trail, now);
          updateArmed();
        }
      }
      effect.frame(now);
      if (!effect.active) {
        runningCameo = false;
        if (!tracking) { stop?.(); stop = null; }
      }
    };
    function ensureRunning() { if (!stop) stop = subscribeFrame(frame); }
    const preview = () => summon(true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { reset(); effect.clear(); runningCameo = false; if (!tracking) { stop?.(); stop = null; } }
    };
    const visibility = () => {
      reset(); effect.clear(); runningCameo = false;
      if (document.hidden) { stop?.(); stop = null; } else if (tracking) ensureRunning();
    };
    const resize = () => effect.resize();
    const reduced = () => { effect.reduced = motion.matches; };
    if (tracking && !document.hidden) ensureRunning();
    window.addEventListener(PREVIEW_EVENT, preview);
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', reduced);
    return () => {
      stop?.(); effect.clear(); setArmed(false);
      window.removeEventListener(PREVIEW_EVENT, preview);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', reduced);
    };
  }, [tracking]);

  const caption = phase === 'drawing' ? 'Open a doorway.' : phase === 'opening' ? 'Someone’s here.'
    : phase === 'arrival' ? 'The multiverse is real.' : phase === 'closing' ? 'Until next time, Peter.'
    : armed ? 'Keep circling…' : '';
  return <div className="sling-ring-layer">
    <canvas ref={canvas} className="sling-ring-canvas" aria-hidden="true" />
    <p className={`sling-ring-caption${caption ? ' visible' : ''}`} role="status" aria-live="polite" aria-atomic="true">{caption}</p>
  </div>;
}
