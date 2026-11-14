export type AgentMotion = { state: string; time: number; elapsed: number; reduced: boolean };

export function drawHolographicAgent(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, id: string, motion: AgentMotion) {
  const working = motion.state === 'working';
  const done = motion.state === 'done';
  const failed = motion.state === 'failed';
  const unavailable = motion.state === 'unavailable';
  const color = failed ? 'oklch(81% .13 70)' : id === 'cursor' ? 'oklch(78% .08 265)' : 'oklch(82% .1 210)';
  const phase = motion.reduced ? 0 : motion.time;
  ctx.save(); ctx.translate(x, y);
  ctx.globalAlpha *= unavailable ? .5 : 1;
  const glow = ctx.createRadialGradient(0, 0, r * .5, 0, 0, r * 1.7);
  glow.addColorStop(0, 'oklch(70% .13 220 / .13)'); glow.addColorStop(1, 'oklch(70% .13 220 / 0)');
  ctx.fillStyle = glow; ctx.fillRect(-r * 1.7, -r * 1.7, r * 3.4, r * 3.4);
  const lens = ctx.createRadialGradient(-r * .35, -r * .4, 0, 0, 0, r);
  lens.addColorStop(0, 'oklch(36% .065 225)'); lens.addColorStop(.7, 'oklch(23% .045 235)'); lens.addColorStop(1, 'oklch(34% .07 220)');
  ctx.fillStyle = lens; ctx.beginPath(); ctx.arc(0, 0, r * .87, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = r * .018;
  ctx.beginPath(); ctx.arc(0, 0, r * .9, 0, Math.PI * 2); ctx.stroke();
  ctx.save(); ctx.globalAlpha *= .2;
  for (const direction of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(0, 0, r * .85, r * .33, direction * .65, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  const breath = .48 + Math.sin(phase * 1.1) * .08;
  ctx.save(); ctx.globalAlpha *= working ? .9 : breath;
  ctx.lineWidth = r * .035; ctx.beginPath();
  const angle = working ? phase * .8 : -.5;
  ctx.arc(0, 0, r * 1.06, angle, angle + Math.PI * 1.35); ctx.stroke();
  ctx.lineWidth = r * .015; ctx.beginPath(); ctx.arc(0, 0, r * 1.18, -angle, -angle + Math.PI * .45); ctx.stroke(); ctx.restore();
  // Provider-specific geometric glyphs, never decorative faces or fake metrics.
  ctx.strokeStyle = color; ctx.lineWidth = r * .055; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
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
      const a = i / 6 * Math.PI * 2;
      ctx.moveTo(Math.cos(a) * r * .12, Math.sin(a) * r * .12);
      ctx.lineTo(Math.cos(a) * r * .34, Math.sin(a) * r * .34);
    }
  }
  ctx.stroke();
  if (working) {
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = .35 + (motion.reduced ? .2 : (Math.sin(phase * 3 - i) + 1) * .3);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc((i - 1) * r * .14, r * .5, r * .035, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (done && !motion.reduced && motion.elapsed < 2) {
    ctx.globalAlpha = (1 - motion.elapsed / 2) * .65;
    ctx.strokeStyle = color; ctx.lineWidth = r * .025;
    ctx.beginPath(); ctx.arc(0, 0, r * (1.15 + motion.elapsed * .22), 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

export function drawHolographicSpace(ctx: CanvasRenderingContext2D) {
  ctx.save();
  // A single projection plane gives depth without filling the UI with widgets.
  const pool = ctx.createRadialGradient(0, 8, 20, 0, 8, 240);
  pool.addColorStop(0, 'oklch(45% .09 220 / .1)'); pool.addColorStop(1, 'oklch(45% .09 220 / 0)');
  ctx.fillStyle = pool; ctx.fillRect(-450, -300, 900, 600);
  ctx.strokeStyle = 'oklch(72% .075 220 / .09)'; ctx.lineWidth = .5;
  for (const radius of [280, 350, 420]) {
    ctx.beginPath(); ctx.ellipse(0, 10, radius, radius * .48, 0, 0, Math.PI * 2); ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const angle = i / 12 * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(Math.cos(angle) * 335, 10 + Math.sin(angle) * 161);
    ctx.lineTo(Math.cos(angle) * 351, 10 + Math.sin(angle) * 169); ctx.stroke();
  }
  // Quiet center reticle, rather than a fourth pretend agent.
  ctx.strokeStyle = 'oklch(78% .09 215 / .22)'; ctx.lineWidth = .65;
  ctx.beginPath(); ctx.ellipse(0, 0, 29, 14, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(7, 0); ctx.moveTo(0, -4); ctx.lineTo(0, 4); ctx.stroke();
  ctx.restore();
}
