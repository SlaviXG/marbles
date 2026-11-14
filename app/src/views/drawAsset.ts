// Deliverables float beside their maker as small sheets of light: glass, a lit
// edge, a scanline passing through, and a beam under them while they are new.
export type AssetMotion = { time: number; age: number; reduced: boolean; focus?: number };

const TAU = Math.PI * 2;

export function drawAsset(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: string, ready = true, motion: AssetMotion = { time: 0, age: 99, reduced: true }) {
  const t = motion.reduced ? 0 : motion.time;
  const focus = motion.focus ?? 0;
  const seed = Math.abs(x * 13.7 + y * 7.3) % TAU;
  const bob = motion.reduced ? 0 : Math.sin(t * 1.2 + seed) * r * .07;
  // Materialise: the sheet is printed upward out of a beam during its first moments.
  const arrive = motion.reduced ? 1 : Math.max(0, Math.min(1, motion.age / 1.1));
  const w = r * 1.44, h = r * 1.84, left = -w / 2, top = -r;
  const base = r * 1.25;
  ctx.save(); ctx.translate(x, y);

  // Projector light on the "floor" under the sheet.
  ctx.save(); ctx.translate(0, base); ctx.scale(1, .28);
  const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.1);
  floor.addColorStop(0, `oklch(82% .12 208 / ${.32 + focus * .2})`); floor.addColorStop(1, 'oklch(80% .12 208 / 0)');
  ctx.fillStyle = floor; ctx.beginPath(); ctx.arc(0, 0, r * 1.1, 0, TAU); ctx.fill(); ctx.restore();
  if (arrive < 1) {
    const beam = ctx.createLinearGradient(0, base, 0, top);
    beam.addColorStop(0, `oklch(90% .1 205 / ${.5 * (1 - arrive)})`); beam.addColorStop(1, 'oklch(90% .1 205 / 0)');
    ctx.fillStyle = beam; ctx.beginPath(); ctx.moveTo(-r * .16, base); ctx.lineTo(r * .16, base); ctx.lineTo(w / 2, top); ctx.lineTo(left, top); ctx.closePath(); ctx.fill();
  }
  ctx.translate(0, bob);

  const sheet = (dx: number, dy: number, tilt: number, alpha: number) => {
    ctx.save(); ctx.translate(dx, dy); ctx.rotate(tilt);
    const glass = ctx.createLinearGradient(left, top, w / 2, top + h);
    glass.addColorStop(0, `oklch(46% .085 215 / ${.5 * alpha})`); glass.addColorStop(1, `oklch(24% .05 232 / ${.72 * alpha})`);
    ctx.fillStyle = glass; ctx.beginPath(); ctx.roundRect(left, top, w, h, r * .1); ctx.fill();
    ctx.strokeStyle = `oklch(84% .1 208 / ${Math.min(1, .75 + focus * .25) * alpha})`; ctx.lineWidth = r * .055;
    ctx.setLineDash(ready ? [] : [r * .16, r * .12]); ctx.lineDashOffset = -t * r * .5;
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
  };

  // Reveal from the bottom up while arriving.
  ctx.save();
  if (arrive < 1) { ctx.beginPath(); ctx.rect(left - r, top + h * (1 - arrive) - r * .2, w + r * 2, h * arrive + r * .6); ctx.clip(); }
  if (type === 'stack') { sheet(r * .26, -r * .2, .13, .55); sheet(r * .13, -r * .1, .065, .75); }
  sheet(0, 0, 0, 1);

  // What kind of thing it is, as a few strokes of light.
  ctx.strokeStyle = 'oklch(88% .07 208 / .85)'; ctx.fillStyle = 'oklch(86% .09 205 / .8)';
  ctx.lineWidth = r * .06; ctx.lineCap = 'round';
  if (type === 'spreadsheet') {
    ctx.fillRect(-r * .5, -r * .72, r, r * .2);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const v = -.36 + i * .34; ctx.moveTo(-r * .5, r * v); ctx.lineTo(r * .5, r * v); }
    for (const v of [-.17, .17]) { ctx.moveTo(r * v, -r * .45); ctx.lineTo(r * v, r * .52); }
    ctx.stroke();
  } else if (type === 'image') {
    ctx.beginPath(); ctx.arc(r * .2, -r * .42, r * .13, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-r * .5, r * .4); ctx.lineTo(-r * .14, -r * .12); ctx.lineTo(r * .1, r * .16); ctx.lineTo(r * .28, -r * .02); ctx.lineTo(r * .5, r * .4); ctx.closePath(); ctx.fill();
  } else if (type === 'slides') {
    ctx.beginPath(); ctx.roundRect(-r * .5, -r * .68, r, r * .6, r * .05); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r * .34, r * .5); ctx.lineTo(-r * .34, r * .26); ctx.moveTo(0, r * .5); ctx.lineTo(0, r * .14); ctx.moveTo(r * .34, r * .5); ctx.lineTo(r * .34, r * .02); ctx.stroke();
  } else {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) { ctx.moveTo(-r * .46, r * (-.62 + i * .27)); ctx.lineTo(r * (i === 4 ? .05 : i === 0 ? .2 : .44), r * (-.62 + i * .27)); }
    ctx.stroke();
  }

  if (!motion.reduced) {
    // A scanline drifting through the sheet keeps it feeling projected.
    const p = (t * .35 + seed) % 1;
    const sy = top + h * p;
    const scan = ctx.createLinearGradient(0, sy - r * .3, 0, sy);
    scan.addColorStop(0, 'oklch(92% .08 205 / 0)'); scan.addColorStop(1, `oklch(94% .08 205 / ${.28 * Math.sin(p * Math.PI)})`);
    ctx.save(); ctx.beginPath(); ctx.roundRect(left, top, w, h, r * .1); ctx.clip();
    ctx.fillStyle = scan; ctx.fillRect(left, sy - r * .3, w, r * .3); ctx.restore();
  }
  ctx.restore();

  if (ready) {
    // A small ready mark is semantic, rather than an ornamental color alone.
    ctx.fillStyle = 'oklch(26% .06 205)'; ctx.beginPath(); ctx.arc(r * .66, r * .68, r * .3, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'oklch(90% .1 195)'; ctx.lineWidth = r * .07; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(r * .66, r * .68, r * .3, 0, TAU); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r * .52, r * .68); ctx.lineTo(r * .62, r * .78); ctx.lineTo(r * .81, r * .57); ctx.stroke();
  }
  ctx.restore();
}
