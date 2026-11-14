import { useEffect, useRef, useState } from 'react';
import { GONE_MS, handDebug, loadParams, pointerTarget, secondaryHand, subscribeParams, usePointerStore } from '../input';
import { subscribeFrame } from '../motion/ticker';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const W = 184, H = 138;
type Feedback = 'waiting' | 'pointing' | 'pinching' | 'zooming' | 'mouse';

export default function GestureWidget() {
  const status = usePointerStore(s => s.status);
  const error = usePointerStore(s => s.error);
  const mode = usePointerStore(s => s.mode);
  const [feedback, setFeedback] = useState<Feedback>('waiting');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (status !== 'tracking') return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    let drawn = -1;
    let params = loadParams();
    const unsubParams = subscribeParams(next => { params = next; drawn = -1; });
    let lastFeedback: Feedback | null = null;
    let wasPresent = false;
    const unsub = subscribeFrame(now => {
      if (document.hidden) return;
      const present = pointerTarget.present && now - pointerTarget.lastSeen <= GONE_MS;
      const secondPresent = secondaryHand.present && now - secondaryHand.lastSeen <= GONE_MS;
      const next: Feedback = !present ? 'waiting' : mode === 'mouse' ? 'mouse'
        : pointerTarget.pinching && secondPresent && secondaryHand.pinching ? 'zooming'
        : pointerTarget.pinching ? 'pinching' : 'pointing';
      if (next !== lastFeedback) { lastFeedback = next; setFeedback(next); }
      if (handDebug.version === drawn && wasPresent === present) return;
      drawn = handDebug.version; wasPresent = present;
      const hands = present ? handDebug.hands : [];
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'oklch(65% .06 220 / .22)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.strokeRect(params.zoneX0 * W, params.zoneY0 * H, (params.zoneX1 - params.zoneX0) * W, (params.zoneY1 - params.zoneY0) * H);
      ctx.setLineDash([]);
      for (const hand of hands) {
        const px = (i: number) => (1 - hand.pts[i * 2]) * W;
        const py = (i: number) => hand.pts[i * 2 + 1] * H;
        const color = hand.primary ? 'oklch(84% .1 210)' : 'oklch(72% .04 240)';
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = hand.primary ? 1.5 : 1;
        ctx.beginPath();
        for (const [a, b] of BONES) { ctx.moveTo(px(a), py(a)); ctx.lineTo(px(b), py(b)); }
        ctx.stroke();
        for (let i = 0; i < hand.pts.length / 2; i++) {
          ctx.beginPath(); ctx.arc(px(i), py(i), i === 4 || i === 8 ? 2.6 : 1.5, 0, Math.PI * 2); ctx.fill();
        }
        if ((hand.primary && pointerTarget.pinching) || (!hand.primary && secondaryHand.pinching)) {
          ctx.strokeStyle = 'oklch(86% .12 80)'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(px(4), py(4)); ctx.lineTo(px(8), py(8)); ctx.stroke();
        }
      }
    });
    return () => { unsub(); unsubParams(); };
  }, [status, mode]);

  const active = status === 'tracking';
  const hasHand = active && feedback !== 'waiting';
  const label = status === 'off' ? 'Camera off' : status === 'starting' ? 'Starting camera…'
    : status === 'denied' ? 'Camera access blocked' : status === 'error' ? 'Camera unavailable'
    : feedback === 'waiting' ? 'Show your hand' : feedback === 'zooming' ? 'Two-hand zoom'
    : feedback === 'pinching' ? 'Pinching' : feedback === 'mouse' ? 'Mouse in control' : 'Hand detected';
  const hint = status === 'off' ? 'Touch the orb to enable gestures.'
    : status === 'starting' ? 'Allow camera access to continue.'
    : status === 'denied' ? 'Allow your camera in the browser, then restart the orb.'
    : status === 'error' ? 'Check your camera, then restart the orb.'
    : feedback === 'mouse' ? 'Move your hand to take control.'
    : feedback === 'zooming' ? 'Move hands apart or together.'
    : 'Point to move. Pinch to select.';

  return <aside className={`gesture-widget ${status}${hasHand ? ' has-hand' : ''}`} aria-label="Gesture recognition" title={error ?? undefined}>
    <div className="gesture-widget-title"><span aria-hidden="true" />Gesture recognition</div>
    <div className="gesture-visual" aria-hidden="true">
      <svg className="gesture-hand-guide" viewBox="0 0 80 100" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 54V26a5 5 0 0 1 10 0v25-35a5 5 0 0 1 10 0v35-30a5 5 0 0 1 10 0v32-23a5 5 0 0 1 10 0v33c0 17-10 27-24 27-11 0-18-7-23-17L7 54a5 5 0 0 1 8-6l9 12" />
        <path d="M27 72c0-8 4-15 11-18M35 90v6m17-8v8" />
      </svg>
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
    </div>
    <p className="gesture-feedback" role="status" aria-live="polite" aria-atomic="true">{label}</p>
    <p className="gesture-widget-hint">{hint}</p>
  </aside>;
}
