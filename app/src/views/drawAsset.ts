export function drawAsset(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: string, ready = true) {
  ctx.save(); ctx.translate(x, y);
  const paper = (dx: number, dy: number, color: string) => {
    ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(-r * .72 + dx, -r + dy, r * 1.44, r * 1.8, r * .12); ctx.fill();
  };
  if (type === 'stack') { paper(r * .18, -r * .16, 'oklch(31% .055 235)'); paper(r * .09, -r * .08, 'oklch(38% .055 230)'); }
  paper(0, 0, 'oklch(25% .04 235)');
  ctx.strokeStyle = 'oklch(72% .085 220)'; ctx.lineWidth = r * .07;
  ctx.beginPath(); ctx.roundRect(-r * .72, -r, r * 1.44, r * 1.8, r * .12); ctx.stroke();
  if (type === 'spreadsheet') {
    ctx.fillStyle = 'oklch(84% .065 165)'; ctx.fillRect(-r * .52, -r * .7, r * 1.04, r * .23);
    ctx.beginPath();
    for (let i = 0; i < 3; i++) { const v = -.45 + i * .35; ctx.moveTo(-r * .52, r * v); ctx.lineTo(r * .52, r * v); ctx.moveTo(r * v, -r * .47); ctx.lineTo(r * v, r * .44); }
    ctx.stroke();
  } else if (type === 'image') {
    ctx.fillStyle = 'oklch(91% .04 220)'; ctx.fillRect(-r * .51, -r * .7, r * 1.02, r * .99);
    ctx.fillStyle = 'oklch(84% .07 95)'; ctx.beginPath(); ctx.arc(r * .22, -r * .45, r * .12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'oklch(75% .07 165)'; ctx.beginPath(); ctx.moveTo(-r * .5, r * .27); ctx.lineTo(-r * .12, -r * .22); ctx.lineTo(r * .1, r * .05); ctx.lineTo(r * .35, -r * .13); ctx.lineTo(r * .51, r * .27); ctx.fill();
  } else if (type === 'slides') {
    ctx.fillStyle = 'oklch(86% .055 295)'; ctx.fillRect(-r * .52, -r * .67, r * 1.04, r * .65);
    ctx.beginPath(); ctx.moveTo(-r * .37, r * .4); ctx.lineTo(-r * .37, r * .15); ctx.moveTo(-r * .05, r * .4); ctx.lineTo(-r * .05, r * .06); ctx.moveTo(r * .27, r * .4); ctx.lineTo(r * .27, -r * .03); ctx.stroke();
  } else {
    ctx.beginPath();
    for (let i = 0; i < 4; i++) { ctx.moveTo(-r * .46, r * (-.57 + i * .28)); ctx.lineTo(r * (i === 3 ? .1 : .42), r * (-.57 + i * .28)); }
    ctx.stroke();
  }
  if (!ready) { ctx.restore(); return; }
  // A tiny ready mark is semantic, rather than an ornamental color alone.
  ctx.fillStyle = 'oklch(35% .06 205)'; ctx.beginPath(); ctx.arc(r * .65, r * .67, r * .3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'oklch(85% .09 210)'; ctx.lineWidth = r * .07;
  ctx.beginPath(); ctx.moveTo(r * .5, r * .66); ctx.lineTo(r * .61, r * .77); ctx.lineTo(r * .81, r * .55); ctx.stroke();
  ctx.restore();
}
