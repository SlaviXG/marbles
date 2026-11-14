import { useEffect, useRef } from 'react';
import { subscribeFrame } from '../motion/ticker';
import { REDUCED_MOTION, voiceSignal } from '../state/hud';

// The voice core: a reactor of light drawn on one small canvas. Everything it
// does is driven by real state (voice status, mic energy, reply playback), so
// it never animates "for show" while nothing is happening beyond a slow idle.
const SIZE = 440; // CSS px; the button it decorates is much smaller
const BARS = 64;
const TAU = Math.PI * 2;

// Cheap deterministic wobble per bar, so the ring looks like a spectrum
// although only one energy value is available from the microphone.
const wobble = (i: number, t: number) =>
  .55 + .45 * Math.sin(i * 1.7 + t * 9.1) * Math.sin(i * .37 - t * 5.3 + 1.2);

export default function VoiceCore() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = SIZE * dpr; canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let level = 0; // smoothed mic energy
    let energy = .2; // overall brightness, eased between states
    let warm = 0; // 0 = cyan (listening to you), 1 = amber (speaking to you)
    let alarm = 0;
    let last = performance.now();
    let drawnKey = '';

    const draw = (now: number) => {
      if (document.hidden) return;
      const dt = Math.min(.05, (now - last) / 1000); last = now;
      const { status, speaking } = voiceSignal;
      const t = REDUCED_MOTION ? 0 : now / 1000;

      const raw = speaking ? .35 + .3 * Math.sin(t * 7) * Math.sin(t * 2.3) : voiceSignal.level;
      level += (raw - level) * (raw > level ? 1 - Math.exp(-dt / .04) : 1 - Math.exp(-dt / .22));
      const targetEnergy = speaking ? 1 : status === 'armed' ? 1 : status === 'listening' ? .9
        : status === 'wake' ? .55 : status === 'loading' || status === 'stopping' ? .45 : status === 'error' ? .6 : .22;
      energy += (targetEnergy - energy) * (1 - Math.exp(-dt / .25));
      warm += ((speaking ? 1 : 0) - warm) * (1 - Math.exp(-dt / .3));
      alarm += ((status === 'error' ? 1 : 0) - alarm) * (1 - Math.exp(-dt / .3));

      if (REDUCED_MOTION) {
        // Static glyph per state: redraw only when the state changes.
        const key = `${status}:${speaking}`;
        if (key === drawnKey) return;
        drawnKey = key; energy = targetEnergy; warm = speaking ? 1 : 0; alarm = status === 'error' ? 1 : 0; level = 0;
      }

      const hue = 205 + warm * -135 + alarm * (25 - 205 - warm * -135);
      const chroma = .12 + warm * .03 + alarm * .08;
      const ink = (l: number, a: number) => `oklch(${l}% ${chroma} ${hue} / ${a})`;
      const c = SIZE / 2;
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save(); ctx.translate(c, c);

      // Atmosphere.
      const glowR = 96 + energy * 50 + level * 40;
      const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, glowR);
      glow.addColorStop(0, ink(72, .28 * energy + .05)); glow.addColorStop(.45, ink(62, .09 * energy)); glow.addColorStop(1, ink(60, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, glowR, 0, TAU); ctx.fill();

      // Wake shockwave: one ring thrown outward when the wake word lands.
      const since = (now - voiceSignal.awakeAt) / 1000;
      if (!REDUCED_MOTION && since >= 0 && since < .9) {
        const p = 1 - Math.pow(1 - since / .9, 3);
        ctx.strokeStyle = ink(90, (1 - p) * .7); ctx.lineWidth = 2.5 * (1 - p) + .4;
        ctx.beginPath(); ctx.arc(0, 0, 44 + p * 168, 0, TAU); ctx.stroke();
        ctx.strokeStyle = ink(85, (1 - p) * .3); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 44 + p * 110, 0, TAU); ctx.stroke();
      }

      // Outer instrument ring: fine ticks, then three long arcs turning slowly.
      ctx.lineCap = 'butt';
      ctx.strokeStyle = ink(80, .12 + energy * .2); ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 72; i++) {
        const a = i / 72 * TAU + t * .05;
        const r0 = i % 6 === 0 ? 79 : 82;
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); ctx.lineTo(Math.cos(a) * 85, Math.sin(a) * 85);
      }
      ctx.stroke();
      ctx.strokeStyle = ink(84, .25 + energy * .5); ctx.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const a = i / 3 * TAU - t * (.18 + energy * .5);
        ctx.beginPath(); ctx.arc(0, 0, 72, a, a + 1.25); ctx.stroke();
      }
      if (status === 'loading' || status === 'stopping') {
        const a = t * 3.4;
        ctx.strokeStyle = ink(94, .9); ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 72, a, a + 1.1); ctx.stroke(); ctx.lineCap = 'butt';
      }

      // Voice ring: radial bars that follow the microphone (or the reply).
      const live = speaking || status === 'listening' || status === 'armed';
      ctx.lineCap = 'round'; ctx.lineWidth = 2.2;
      for (let i = 0; i < BARS; i++) {
        const a = i / BARS * TAU - Math.PI / 2;
        const amp = live ? level * wobble(i, t) : 0;
        const len = 2 + amp * 30 + (live ? 1.5 : 0);
        const r0 = 50;
        ctx.strokeStyle = ink(80 + amp * 18, .22 + energy * .4 + amp * .4);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len));
        ctx.stroke();
      }

      // Reactor: ten trapezoid cells around the core, counter-rotating.
      ctx.save(); ctx.rotate(t * (.12 + energy * .25));
      for (let i = 0; i < 10; i++) {
        const a0 = i / 10 * TAU + .07, a1 = (i + 1) / 10 * TAU - .07;
        ctx.beginPath(); ctx.arc(0, 0, 43, a0, a1); ctx.arc(0, 0, 33, a1, a0, true); ctx.closePath();
        const pulse = REDUCED_MOTION ? .5 : .5 + .5 * Math.sin(t * 2.2 - i * .63);
        ctx.fillStyle = ink(74, .06 + energy * (.16 + pulse * .2) + level * .25);
        ctx.fill();
        ctx.strokeStyle = ink(86, .2 + energy * .5); ctx.lineWidth = .8; ctx.stroke();
      }
      ctx.restore();

      // Core.
      const coreR = 22 + level * 7 + energy * 3;
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, `oklch(99% .02 ${hue} / ${.35 + energy * .65})`);
      core.addColorStop(.5, ink(86, .25 + energy * .55)); core.addColorStop(1, ink(70, 0));
      ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, coreR, 0, TAU); ctx.fill();
      ctx.strokeStyle = ink(92, .35 + energy * .5); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, 0, 27, 0, TAU); ctx.stroke();

      ctx.restore();
    };

    draw(performance.now());
    return subscribeFrame(draw);
  }, []);

  return <canvas ref={ref} className="voice-core-canvas" style={{ width: SIZE, height: SIZE }} aria-hidden="true" />;
}
