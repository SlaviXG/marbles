// Canvas drawing for the projected scene. Everything is drawn in graph units,
// inside the force-graph's own frame, so it pans and zooms with the team.
export type AgentMotion = { state: string; time: number; elapsed: number; reduced: boolean; focus?: number };
export type SpaceMotion = { time: number; scale: number; reduced: boolean; energy: number; level: number };

const TAU = Math.PI * 2;
const TILT = .48; // the projection plane is a circle seen at an angle

// Stable pseudo-random dust, generated once.
const DUST = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => { const x = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return x - Math.floor(x); };
  return { x: (r(1) - .5) * 1100, y: (r(2) - .5) * 640, size: .5 + r(3) * 1.1, speed: 2 + r(4) * 5, phase: r(5) * TAU };
});

export function drawHolographicSpace(ctx: CanvasRenderingContext2D, motion: SpaceMotion) {
  const { time: t, energy, level } = motion;
  const hair = Math.max(.35, .7 / motion.scale);
  ctx.save();

  // Light pooled on the floor of the projection.
  const pool = ctx.createRadialGradient(0, 14, 10, 0, 14, 330);
  pool.addColorStop(0, `oklch(52% .11 215 / ${.13 + energy * .08})`); pool.addColorStop(.5, 'oklch(45% .09 225 / .05)'); pool.addColorStop(1, 'oklch(45% .09 220 / 0)');
  ctx.save(); ctx.scale(1, .62); ctx.fillStyle = pool; ctx.beginPath(); ctx.arc(0, 14, 330, 0, TAU); ctx.fill(); ctx.restore();

  // Dust in the beam.
  for (const mote of DUST) {
    const y = ((mote.y - t * mote.speed + 320) % 640 + 640) % 640 - 320;
    const twinkle = motion.reduced ? .5 : .5 + .5 * Math.sin(t * 1.3 + mote.phase);
    ctx.fillStyle = `oklch(86% .07 210 / ${.05 + twinkle * .16})`;
    ctx.beginPath(); ctx.arc(mote.x, y, mote.size, 0, TAU); ctx.fill();
  }

  // The plane: work in a squashed space so circles land as ellipses.
  ctx.save(); ctx.translate(0, 12); ctx.scale(1, TILT);

  if (!motion.reduced && typeof ctx.createConicGradient === 'function') {
    // One slow sweep, like a scanner checking in on the team.
    const sweep = ctx.createConicGradient(t * .35, 0, 0);
    sweep.addColorStop(0, 'oklch(80% .12 210 / 0)'); sweep.addColorStop(.9, 'oklch(80% .12 210 / 0)');
    sweep.addColorStop(.998, `oklch(84% .12 210 / ${.035 + energy * .05})`); sweep.addColorStop(1, 'oklch(80% .12 210 / 0)');
    ctx.fillStyle = sweep; ctx.beginPath(); ctx.arc(0, 0, 338, 0, TAU); ctx.arc(0, 0, 60, 0, TAU, true); ctx.fill();
    // ...and its leading edge, a hairline.
    const lead = t * .35;
    ctx.strokeStyle = `oklch(88% .1 208 / ${.16 + energy * .14})`; ctx.lineWidth = hair;
    ctx.beginPath(); ctx.moveTo(Math.cos(lead) * 60, Math.sin(lead) * 60); ctx.lineTo(Math.cos(lead) * 338, Math.sin(lead) * 338); ctx.stroke();
  }

  const ring = (radius: number, alpha: number, width = hair, dash?: number[], offset = 0) => {
    ctx.strokeStyle = `oklch(78% .09 215 / ${alpha})`; ctx.lineWidth = width;
    ctx.setLineDash(dash ?? []); ctx.lineDashOffset = offset;
    ctx.beginPath(); ctx.arc(0, 0, radius, 0, TAU); ctx.stroke();
  };
  ring(190, .1 + energy * .1);
  ring(262, .08, hair, [2, 9], t * 5);
  ring(338, .13 + energy * .08);
  ring(352, .2 + energy * .15, hair * 2.4, [70, 46, 190, 46], -t * 9);
  ring(430, .07, hair, [1, 6], t * 3);
  ctx.setLineDash([]);

  // Bearing ticks around the main ring.
  ctx.strokeStyle = `oklch(80% .09 215 / ${.16 + energy * .1})`; ctx.lineWidth = hair;
  ctx.beginPath();
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * TAU, r0 = i % 6 === 0 ? 362 : 366, c = Math.cos(a), s = Math.sin(a);
    ctx.moveTo(c * r0, s * r0); ctx.lineTo(c * 372, s * 372);
  }
  ctx.stroke();
  ctx.restore();

  // Centre mark: a quiet reticle that breathes with the user's voice.
  const pulse = 1 + level * .5;
  ctx.strokeStyle = `oklch(84% .1 212 / ${.25 + energy * .3})`; ctx.lineWidth = hair * 1.3;
  ctx.beginPath(); ctx.ellipse(0, 0, 30 * pulse, 30 * pulse * TILT, 0, 0, TAU); ctx.stroke();
  ctx.setLineDash([3, 5]); ctx.lineDashOffset = -t * 6;
  ctx.beginPath(); ctx.ellipse(0, 0, 44 * pulse, 44 * pulse * TILT, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(8, 0); ctx.moveTo(0, -5); ctx.lineTo(0, 5); ctx.stroke();
  ctx.restore();
}

/** A line of light from the centre to a teammate; pulses run outward while it works. */
export function drawTether(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, motion: { time: number; scale: number; working: boolean; reduced: boolean; alpha: number; burst?: number }) {
  const length = Math.hypot(x, y);
  if (length < r * 2 + 50) return;
  const ux = x / length, uy = y / length;
  const from = 46, to = length - r * 1.45;
  ctx.save(); ctx.globalAlpha *= motion.alpha;
  const line = ctx.createLinearGradient(ux * from, uy * from, ux * to, uy * to);
  line.addColorStop(0, 'oklch(80% .1 212 / 0)'); line.addColorStop(.5, `oklch(80% .1 212 / ${motion.working ? .45 : .2})`); line.addColorStop(1, `oklch(84% .1 212 / ${motion.working ? .6 : .32})`);
  ctx.strokeStyle = line; ctx.lineWidth = Math.max(.4, .8 / motion.scale);
  ctx.beginPath(); ctx.moveTo(ux * from, uy * from); ctx.lineTo(ux * to, uy * to); ctx.stroke();
  const burst = motion.burst ?? 99;
  if (!motion.reduced && burst >= 0 && burst < .9) {
    const p = 1 - Math.pow(1 - burst / .9, 2);
    const d = from + (to - from) * p;
    const tail = Math.max(from, d - 70);
    const streak = ctx.createLinearGradient(ux * tail, uy * tail, ux * d, uy * d);
    streak.addColorStop(0, 'oklch(92% .09 205 / 0)'); streak.addColorStop(1, 'oklch(98% .04 205 / 1)');
    ctx.strokeStyle = streak; ctx.lineWidth = Math.max(1.4, 2.6 / motion.scale); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(ux * tail, uy * tail); ctx.lineTo(ux * d, uy * d); ctx.stroke();
    ctx.fillStyle = 'oklch(88% .13 205 / .35)'; ctx.beginPath(); ctx.arc(ux * d, uy * d, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ux * d, uy * d, 2.6, 0, TAU); ctx.fill();
  }
  if (motion.working && !motion.reduced) {
    for (let i = 0; i < 3; i++) {
      const p = (motion.time * .55 + i / 3) % 1;
      const d = from + (to - from) * p;
      const fade = Math.sin(p * Math.PI);
      ctx.fillStyle = `oklch(95% .06 205 / ${fade})`;
      ctx.beginPath(); ctx.arc(ux * d, uy * d, 1.7, 0, TAU); ctx.fill();
      ctx.fillStyle = `oklch(85% .12 210 / ${fade * .25})`;
      ctx.beginPath(); ctx.arc(ux * d, uy * d, 5, 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

/** Work waiting for a free agent: small sheets stacked at the centre, with a count. */
export function drawQueue(ctx: CanvasRenderingContext2D, count: number, motion: { time: number; scale: number; reduced: boolean }) {
  const shown = Math.min(count, 4), w = 15, h = 19, gap = 5;
  const bob = motion.reduced ? 0 : Math.sin(motion.time * 1.6) * 1.2;
  ctx.save(); ctx.translate(-((shown - 1) * (w + gap)) / 2, -34 + bob);
  for (let i = 0; i < shown; i++) {
    const pulse = motion.reduced ? .6 : .45 + .35 * Math.sin(motion.time * 2.4 - i * .9);
    ctx.fillStyle = `oklch(40% .08 215 / ${.4 + pulse * .25})`; ctx.strokeStyle = `oklch(86% .1 208 / ${.5 + pulse * .5})`;
    ctx.lineWidth = Math.max(.6, 1 / motion.scale); ctx.setLineDash([2.5, 2]); ctx.lineDashOffset = -motion.time * 5;
    ctx.beginPath(); ctx.roundRect(i * (w + gap) - w / 2, -h / 2, w, h, 2); ctx.fill(); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.restore();
  ctx.save();
  ctx.font = `500 ${9.5 / motion.scale}px "DIN Alternate", "Bahnschrift", ui-sans-serif, system-ui, sans-serif`;
  if ('letterSpacing' in ctx) (ctx as any).letterSpacing = `${1.9 / motion.scale}px`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = 'oklch(84% .11 208)';
  ctx.fillText(`${count} QUEUED`, 0, 26);
  ctx.restore();
}

/** A dial around a working agent: one lap a minute of real elapsed time, with a
 * bright band running ahead of it so it never looks stalled. */
export function drawProgressDial(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, motion: { time: number; seconds: number; scale: number; reduced: boolean }) {
  const TICKS = 60, inner = r * 1.56, outer = r * 1.68;
  const lap = (motion.seconds % 60) / 60;
  const band = motion.reduced ? -1 : (motion.time * .45) % 1;
  ctx.save(); ctx.translate(x, y); ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(.7, 1.3 / motion.scale);
  for (let i = 0; i < TICKS; i++) {
    const p = i / TICKS, a = p * TAU - Math.PI / 2;
    const ahead = band < 0 ? 1 : ((p - band + 1) % 1);
    const sweep = band < 0 ? 0 : Math.max(0, 1 - ahead * 5) ;
    const filled = p <= lap;
    ctx.strokeStyle = `oklch(${filled ? 88 : 74}% .11 208 / ${Math.min(1, (filled ? .7 : .16) + sweep * .8)})`;
    const reach = outer + (i % 5 === 0 ? r * .05 : 0) + sweep * r * .06;
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner); ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach); ctx.stroke();
  }
  // The minute hand's tip.
  const tip = lap * TAU - Math.PI / 2;
  ctx.fillStyle = 'oklch(97% .04 205)'; ctx.beginPath(); ctx.arc(Math.cos(tip) * outer, Math.sin(tip) * outer, r * .045, 0, TAU); ctx.fill();
  ctx.restore();
}

/** Four brackets closing in on whatever the hand is aimed at. */
export function drawLockOn(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, amount: number, scale: number, selected: boolean) {
  if (amount < .003) return;
  const a = Math.min(1.15, amount);
  const radius = r * (1.55 + (1 - a) * .7);
  ctx.save(); ctx.translate(x, y); ctx.rotate((1 - a) * .8 + Math.PI / 4);
  ctx.globalAlpha *= Math.min(1, amount);
  ctx.strokeStyle = selected ? 'oklch(93% .07 200)' : 'oklch(86% .11 208)';
  ctx.lineWidth = Math.max(.8, 1.6 / scale); ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const mid = i / 4 * TAU;
    ctx.beginPath(); ctx.arc(0, 0, radius, mid - .34, mid + .34); ctx.stroke();
  }
  ctx.globalAlpha *= .5; ctx.lineWidth = Math.max(.4, .7 / scale);
  for (let i = 0; i < 4; i++) {
    const mid = i / 4 * TAU + Math.PI / 4, c = Math.cos(mid), s = Math.sin(mid);
    ctx.beginPath(); ctx.moveTo(c * radius * .93, s * radius * .93); ctx.lineTo(c * radius * 1.07, s * radius * 1.07); ctx.stroke();
  }
  ctx.restore();
}

export function drawHolographicAgent(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, id: string, motion: AgentMotion) {
  const working = motion.state === 'working';
  const done = motion.state === 'done';
  const failed = motion.state === 'failed';
  const unavailable = motion.state === 'unavailable';
  const hue = failed ? 70 : id === 'cursor' ? 262 : 208;
  const ink = (l: number, a: number, c = .11) => `oklch(${l}% ${c} ${hue} / ${a})`;
  const color = ink(failed ? 82 : 84, 1, failed ? .14 : .11);
  const t = motion.reduced ? 0 : motion.time;
  const focus = motion.focus ?? 0;
  ctx.save(); ctx.translate(x, y);
  ctx.globalAlpha *= unavailable ? .42 : 1;

  // Bloom.
  const reach = r * (working ? 2.5 : 1.9 + focus * .3);
  const glow = ctx.createRadialGradient(0, 0, r * .4, 0, 0, reach);
  glow.addColorStop(0, ink(72, working ? .3 : .16 + focus * .1, .14)); glow.addColorStop(1, ink(70, 0, .13));
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, reach, 0, TAU); ctx.fill();

  // Lens: dark glass with a lit rim.
  const lens = ctx.createRadialGradient(-r * .3, -r * .38, 0, 0, 0, r * .9);
  lens.addColorStop(0, ink(40, .95, .075)); lens.addColorStop(.65, ink(20, .95, .045)); lens.addColorStop(1, ink(33, .95, .08));
  ctx.fillStyle = lens; ctx.beginPath(); ctx.arc(0, 0, r * .86, 0, TAU); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = r * .028;
  ctx.setLineDash(unavailable ? [r * .08, r * .1] : []);
  ctx.beginPath(); ctx.arc(0, 0, r * .88, 0, TAU); ctx.stroke(); ctx.setLineDash([]);

  // Gyroscope: two faint orbits inside the lens.
  ctx.save(); ctx.globalAlpha *= .22; ctx.lineWidth = r * .015;
  for (const direction of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(0, 0, r * .84, r * .3, direction * .65 + t * .12 * direction, 0, TAU); ctx.stroke();
  }
  ctx.restore();

  if (!unavailable) {
    // Segmented ring: turns lazily at rest, spins up while working.
    const spin = t * (working ? 1.5 : .22);
    const breath = motion.reduced ? .55 : .5 + Math.sin(t * 1.1 + r) * .12;
    ctx.save(); ctx.globalAlpha *= Math.min(1, working ? .95 : breath + focus * .3);
    ctx.lineWidth = r * .045; ctx.lineCap = 'butt';
    for (let i = 0; i < 3; i++) {
      const a = spin + i / 3 * TAU;
      ctx.beginPath(); ctx.arc(0, 0, r * 1.08, a, a + TAU / 3 - .42); ctx.stroke();
    }
    // Fine counter-rotating scale.
    ctx.globalAlpha *= .55; ctx.lineWidth = r * .05;
    ctx.setLineDash([r * .012, r * .085]); ctx.lineDashOffset = spin * r * .6;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.24, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();

    if (working && !motion.reduced) {
      // A comet on the outer ring: unmistakably busy, even at a distance.
      const a = t * 2.1;
      ctx.lineCap = 'round'; ctx.lineWidth = r * .05;
      for (let i = 0; i < 10; i++) {
        ctx.strokeStyle = ink(92, (1 - i / 10) * .8, .08);
        ctx.beginPath(); ctx.arc(0, 0, r * 1.4, a - (i + 1) * .13, a - i * .13); ctx.stroke();
      }
      ctx.fillStyle = ink(97, 1, .04);
      ctx.beginPath(); ctx.arc(Math.cos(a) * r * 1.4, Math.sin(a) * r * 1.4, r * .055, 0, TAU); ctx.fill();
    }
  }

  // Provider-specific geometric glyphs, never decorative faces or fake metrics.
  ctx.strokeStyle = color; ctx.lineWidth = r * .06; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (done) {
    ctx.moveTo(-r * .25, 0); ctx.lineTo(-r * .04, r * .2); ctx.lineTo(r * .32, -r * .23);
  } else if (failed) {
    ctx.moveTo(0, -r * .35); ctx.lineTo(r * .36, r * .26); ctx.lineTo(-r * .36, r * .26); ctx.closePath();
    ctx.moveTo(0, -r * .12); ctx.lineTo(0, r * .07);
  } else if (id === 'codex') {
    ctx.moveTo(-r * .1, -r * .22); ctx.lineTo(-r * .34, 0); ctx.lineTo(-r * .1, r * .22);
    ctx.moveTo(r * .1, -r * .22); ctx.lineTo(r * .34, 0); ctx.lineTo(r * .1, r * .22);
  } else if (id === 'cursor') {
    ctx.moveTo(-r * .19, -r * .3); ctx.lineTo(r * .31, 0); ctx.lineTo(r * .05, r * .08); ctx.lineTo(-r * .1, r * .33); ctx.closePath();
  } else {
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU;
      ctx.moveTo(Math.cos(a) * r * .12, Math.sin(a) * r * .12);
      ctx.lineTo(Math.cos(a) * r * .34, Math.sin(a) * r * .34);
    }
  }
  ctx.stroke();

  const base = ctx.globalAlpha;
  if (working) {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = base * (.35 + (motion.reduced ? .2 : (Math.sin(t * 3 - i) + 1) * .3));
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc((i - 1) * r * .14, r * .5, r * .035, 0, TAU); ctx.fill();
    }
  }
  if ((done || failed) && !motion.reduced && motion.elapsed < 2.4) {
    // State change: two rings thrown outward, once.
    for (const delay of [0, .35]) {
      const p = (motion.elapsed - delay) / 1.6;
      if (p <= 0 || p >= 1) continue;
      const eased = 1 - Math.pow(1 - p, 3);
      ctx.globalAlpha = base * (1 - eased) * .8;
      ctx.strokeStyle = color; ctx.lineWidth = r * .04 * (1 - eased) + r * .008;
      ctx.beginPath(); ctx.arc(0, 0, r * (1.1 + eased * 1.5), 0, TAU); ctx.stroke();
    }
  }
  ctx.restore();
}
