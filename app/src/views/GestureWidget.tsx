import { useEffect, useRef, useState } from 'react';
import { GONE_MS, handDebug, loadParams, pointerTarget, secondaryHand, subscribeParams, usePointerStore } from '../input';
import { subscribeFrame } from '../motion/ticker';
import { useAttention } from '../attention/AttentionTracker';
import { previewPortal } from './SlingRingPortal';

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
  const attention = useAttention(s => s.status);
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
      const hands = present ? handDebug.hands.filter(hand => hand.active) : [];
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = 'oklch(70% .08 215 / .3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.strokeRect(params.zoneX0 * W, params.zoneY0 * H, (params.zoneX1 - params.zoneX0) * W, (params.zoneY1 - params.zoneY0) * H);
      ctx.setLineDash([]);
      for (const hand of hands) {
        const px = (i: number) => (1 - hand.pts[i * 2]) * W;
        const py = (i: number) => hand.pts[i * 2 + 1] * H;
        const pinched = (hand.primary && pointerTarget.pinching) || (!hand.primary && secondaryHand.pinching);
        const color = pinched ? 'oklch(88% .13 78)' : hand.primary ? 'oklch(88% .11 205)' : 'oklch(74% .06 235)';
        ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = hand.primary ? 1.6 : 1.1;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.shadowColor = color; ctx.shadowBlur = 8;
        ctx.beginPath();
        for (const [a, b] of BONES) { ctx.moveTo(px(a), py(a)); ctx.lineTo(px(b), py(b)); }
        ctx.stroke();
        ctx.shadowBlur = 0;
        for (let i = 0; i < hand.pts.length / 2; i++) {
          ctx.beginPath(); ctx.arc(px(i), py(i), i === 4 || i === 8 ? 2.8 : 1.5, 0, Math.PI * 2); ctx.fill();
        }
        // Mark the working point: a ring around the pinch, or the fingertip aimed with.
        const cx = pinched ? (px(4) + px(8)) / 2 : px(8), cy = pinched ? (py(4) + py(8)) / 2 : py(8);
        ctx.lineWidth = 1; ctx.globalAlpha = pinched ? 1 : .55;
        ctx.beginPath(); ctx.arc(cx, cy, pinched ? 7 : 9, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
    });
    return () => { unsub(); unsubParams(); };
  }, [status, mode]);

  const active = status === 'tracking';
  const hasHand = active && feedback !== 'waiting';
  const label = status === 'off' ? 'Gestures off' : status === 'starting' ? 'Starting camera'
    : status === 'denied' ? 'Camera blocked' : status === 'error' ? 'Camera unavailable'
    : feedback === 'waiting' ? 'Show your hand' : feedback === 'zooming' ? 'Zoom'
    : feedback === 'pinching' ? 'Pinch' : feedback === 'mouse' ? 'Mouse control' : 'Tracking';
  // Words only when something needs doing; the live hand speaks for itself.
  const hint = status === 'denied' ? 'Allow your camera in the browser, then restart the orb.'
    : status === 'error' ? 'Check your camera, then restart the orb.' : '';

  return <aside className={`gesture-widget ${status} feedback-${feedback}${hasHand ? ' has-hand' : ''}`} aria-label="Gesture recognition" title={error ?? undefined}>
    <div className="gesture-visual" aria-hidden="true">
      <svg className="gesture-hand-guide" viewBox="0 0 80 100" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 54V26a5 5 0 0 1 10 0v25-35a5 5 0 0 1 10 0v35-30a5 5 0 0 1 10 0v32-23a5 5 0 0 1 10 0v33c0 17-10 27-24 27-11 0-18-7-23-17L7 54a5 5 0 0 1 8-6l9 12" />
      </svg>
      <canvas ref={canvasRef} style={{ width: W, height: H }} />
      <i className="holo-corner tl" /><i className="holo-corner tr" /><i className="holo-corner bl" /><i className="holo-corner br" />
    </div>
    <p className="gesture-feedback" role="status" aria-live="polite" aria-atomic="true"><span aria-hidden="true" />{label}</p>
    {(attention === 'looking' || attention === 'away') && <p className={`attention-badge ${attention}`} role="status">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.6" /></svg>
      {attention === 'looking' ? 'Eyes on' : 'Looking away'}
    </p>}
    {hint && <p className="gesture-widget-hint">{hint}</p>}
    <details className="portal-trick">
      <summary>Portal trick</summary>
      <p>With gestures on, draw one big circle with your index finger in 1–3 seconds. Keep your thumb apart. Either direction works.</p>
      <button type="button" onClick={previewPortal}>Preview portal</button>
    </details>
  </aside>;
}
