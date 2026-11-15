import type { PortalPoint } from '../input/portalGesture';
import { springProgress } from '../motion/springs';

export const PORTAL_TIMING = { draw: 1700, open: 1200, hold: 3300, close: 1100, embers: 1200 };
export const PORTAL_DURATION = Object.values(PORTAL_TIMING).reduce((a, b) => a + b, 0);
export const MAX_SPARKS = 1100;
export type PortalPhase = 'idle' | 'drawing' | 'opening' | 'arrival' | 'closing' | 'embers';
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const mix = (a: number, b: number, p: number) => a + (b - a) * p;
const TAU = Math.PI * 2;

export function portalPhase(elapsed: number): PortalPhase {
  if (elapsed < 0 || elapsed >= PORTAL_DURATION) return 'idle';
  const { draw, open, hold, close } = PORTAL_TIMING;
  if (elapsed < draw) return 'drawing';
  if (elapsed < draw + open) return 'opening';
  if (elapsed < draw + open + hold) return 'arrival';
  if (elapsed < draw + open + hold + close) return 'closing';
  return 'embers';
}

type Spark = { x: number; y: number; vx: number; vy: number; born: number; life: number; size: number; heat: number };
type Shape = { x: number; y: number; rx: number; ry: number };

// One canvas, a capped particle pool, analytic ballistic trails and the app's
// shared ticker. No per-particle DOM, filters, shadows or React frame updates.
export class SlingRingEffect {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private sparks: Spark[] = [];
  private trail: readonly PortalPoint[] = [];
  private lastTrailAt = -Infinity;
  private lastTip: PortalPoint | null = null;
  private start = -Infinity;
  private previous = 0;
  private origin: Shape | null = null;
  private lastPhase: PortalPhase = 'idle';
  private seed = 97123;
  private image = new Image();
  private imageReady = false;
  private glow: HTMLCanvasElement;
  reduced = false;

  constructor(private canvas: HTMLCanvasElement, private onPhase: (phase: PortalPhase) => void) {
    this.ctx = canvas.getContext('2d')!;
    this.image.onload = () => { this.imageReady = true; };
    this.image.src = '/images/portal-spiderman.jpg';
    this.glow = document.createElement('canvas');
    this.glow.width = this.glow.height = 64;
    const g = this.glow.getContext('2d')!;
    const glow = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, 'oklch(98% .04 95)');
    glow.addColorStop(.12, 'oklch(90% .17 80 / .9)');
    glow.addColorStop(.35, 'oklch(72% .2 48 / .4)');
    glow.addColorStop(1, 'oklch(60% .2 40 / 0)');
    g.fillStyle = glow; g.fillRect(0, 0, 64, 64);
    this.resize();
  }

  get active() { return Number.isFinite(this.start) || this.sparks.length > 0 || this.trail.length > 0; }

  resize() {
    this.width = window.innerWidth; this.height = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private random() { this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0; return this.seed / 4294967296; }

  private emit(x: number, y: number, angle: number, count: number, now: number, power = 1) {
    if (this.reduced) return;
    const available = MAX_SPARKS - this.sparks.length;
    for (let i = 0; i < Math.min(count, available); i++) {
      const direction = angle + (this.random() - .5) * 1.3;
      const speed = (65 + this.random() ** 2 * 430) * power;
      this.sparks.push({ x, y, vx: Math.cos(direction) * speed, vy: Math.sin(direction) * speed,
        born: now, life: 450 + this.random() * 1150, size: .6 + this.random() * 1.5, heat: this.random() });
    }
  }

  trace(points: readonly PortalPoint[], now: number) {
    if (Number.isFinite(this.start) || this.reduced) return;
    this.trail = points;
    this.lastTrailAt = now;
    const tip = points[points.length - 1];
    if (tip && tip.t !== this.lastTip?.t) {
      const previous = points[points.length - 2] ?? tip;
      const angle = Math.atan2((tip.y - previous.y) * this.height, (tip.x - previous.x) * this.width);
      this.emit(tip.x * this.width, tip.y * this.height, angle + .6, 22, now, .65);
      this.lastTip = tip;
    }
  }

  summon(now: number, circle?: readonly PortalPoint[]) {
    this.resize();
    this.start = now - (circle?.length ? PORTAL_TIMING.draw : 0);
    this.previous = now;
    if (circle?.length) {
      const xs = circle.map(p => p.x), ys = circle.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      this.origin = { x: (x0 + x1) / 2 * this.width, y: (y0 + y1) / 2 * this.height,
        rx: Math.max(24, (x1 - x0) / 2 * this.width), ry: Math.max(24, (y1 - y0) / 2 * this.height) };
    } else this.origin = null;
    this.trail = []; this.lastTip = null;
  }

  clear() {
    this.start = -Infinity; this.sparks = []; this.trail = []; this.lastTip = null;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.phase('idle');
  }

  private phase(next: PortalPhase) {
    if (next !== this.lastPhase) { this.lastPhase = next; this.onPhase(next); }
  }

  frame(now: number) {
    const ctx = this.ctx;
    const dt = Math.min(.05, Math.max(0, (now - this.previous) / 1000));
    this.previous = now;
    ctx.clearRect(0, 0, this.width, this.height);
    const elapsed = now - this.start;
    const phase = portalPhase(elapsed);
    this.phase(phase);
    if (phase === 'idle') this.start = -Infinity;
    if (now - this.lastTrailAt > 240) this.trail = [];

    if (phase !== 'idle') {
      const { draw, open, hold, close } = PORTAL_TIMING;
      const age = elapsed / 1000;
      const opening = clamp((elapsed - draw) / open);
      const closing = clamp((elapsed - draw - open - hold) / close);
      const grow = springProgress('heavy', opening * .5);
      const shrink = springProgress('calm', closing * .3);
      const ry = Math.min(this.height * .34, this.width * .42, 310);
      const target: Shape = { x: this.width / 2, y: this.height * .47, rx: ry * .77, ry };
      const initial = this.origin ?? { ...target, rx: target.rx * .78, ry: target.ry * .78 };
      const shape: Shape = this.reduced ? target : {
        x: mix(initial.x, target.x, grow), y: mix(initial.y, target.y, grow),
        rx: mix(initial.rx, target.rx, grow) * (1 - shrink),
        ry: mix(initial.ry, target.ry, grow) * (1 - shrink),
      };
      const drawing = phase === 'drawing';
      const arc = drawing && !this.reduced ? clamp(elapsed / draw) : 1;
      const fade = this.reduced ? clamp(elapsed / 300) * (1 - closing) : 1 - clamp((closing - .8) * 5);
      const light = phase === 'embers' ? 0 : fade;

      // The room darkens as the ring gathers heat; a warm floor spill anchors it.
      ctx.fillStyle = `oklch(5% .015 250 / ${.55 * light * (drawing ? arc : 1)})`;
      ctx.fillRect(0, 0, this.width, this.height);
      if (light > 0) {
        const radius = Math.max(shape.ry * 2.1, 1);
        const ambient = ctx.createRadialGradient(shape.x, shape.y, 0, shape.x, shape.y, radius);
        ambient.addColorStop(0, `oklch(65% .18 45 / ${.13 * light})`);
        ambient.addColorStop(.6, `oklch(65% .18 45 / ${.08 * light})`);
        ambient.addColorStop(1, 'oklch(65% .18 45 / 0)');
        ctx.fillStyle = ambient; ctx.fillRect(0, 0, this.width, this.height);
        ctx.save(); ctx.translate(target.x, target.y + target.ry + 14); ctx.scale(2.6, .21);
        ctx.globalAlpha = .3 * light * arc; ctx.drawImage(this.glow, -100, -100, 200, 200); ctx.restore();
      }

      if (!drawing && phase !== 'embers' && shape.rx > 1) {
        ctx.save(); ctx.beginPath(); ctx.ellipse(shape.x, shape.y, shape.rx, shape.ry, 0, 0, TAU); ctx.clip();
        ctx.globalAlpha = this.reduced ? light : 1;
        ctx.fillStyle = 'oklch(8% .025 260)'; ctx.fillRect(0, 0, this.width, this.height);
        const reveal = this.reduced ? light : clamp((opening - .18) / .6) * (1 - closing);
        if (this.imageReady && reveal > 0) {
          ctx.globalAlpha = reveal * (this.reduced ? light : 1);
          const zoom = this.reduced ? 1 : 1.14 - grow * .14;
          const ih = target.ry * 2 * zoom, iw = ih * this.image.naturalWidth / this.image.naturalHeight;
          ctx.drawImage(this.image, shape.x - iw * .52, shape.y - ih / 2, iw, ih);
        }
        const depth = ctx.createRadialGradient(shape.x, shape.y, shape.rx * .2, shape.x, shape.y, shape.ry);
        depth.addColorStop(0, 'oklch(8% .025 260 / 0)'); depth.addColorStop(1, 'oklch(8% .025 260 / .7)');
        ctx.globalAlpha = this.reduced ? light : 1; ctx.fillStyle = depth; ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();
      }

      if (phase !== 'embers') {
        ctx.save(); ctx.globalAlpha = light;
        this.ring(shape, arc, this.reduced ? 0 : age);
        ctx.restore();
        if (!this.reduced) {
          // Dense tangential spray all around the aperture, with a fierce hot
          // spot that races around the advancing edge of the drawn circle.
          const count = Math.ceil(dt * (drawing ? 170 : phase === 'closing' ? 900 : 680));
          for (let i = 0; i < count; i++) {
            const a = drawing ? -Math.PI / 2 + arc * TAU : this.random() * TAU;
            const x = shape.x + Math.cos(a) * shape.rx, y = shape.y + Math.sin(a) * shape.ry;
            this.emit(x, y, a + 1.05, 1, now, drawing ? 1.2 : 1);
          }
          const head = -Math.PI / 2 + (drawing ? arc * TAU : age * 5);
          const hx = shape.x + Math.cos(head) * shape.rx, hy = shape.y + Math.sin(head) * shape.ry;
          ctx.globalCompositeOperation = 'lighter';
          ctx.drawImage(this.glow, hx - 42, hy - 42, 84, 84);
          ctx.globalCompositeOperation = 'source-over';
          if (phase === 'opening' && opening < .5) {
            ctx.globalAlpha = (1 - opening * 2) * .4;
            ctx.strokeStyle = 'oklch(85% .16 75)'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.ellipse(shape.x, shape.y, shape.rx * (1 + opening), shape.ry * (1 + opening), 0, 0, TAU); ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
      }
    }

    if (!this.reduced && this.trail.length > 1) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [width, color] of [[12, 'oklch(65% .2 45 / .15)'], [4, 'oklch(82% .19 70 / .7)'], [1.3, 'oklch(97% .07 90)']] as const) {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
        this.trail.forEach((p, i) => i ? ctx.lineTo(p.x * this.width, p.y * this.height) : ctx.moveTo(p.x * this.width, p.y * this.height));
        ctx.stroke();
      }
      const tip = this.trail[this.trail.length - 1];
      ctx.drawImage(this.glow, tip.x * this.width - 30, tip.y * this.height - 30, 60, 60);
      ctx.restore();
    }
    this.drawSparks(now);
  }

  private ring(shape: Shape, arc: number, age: number) {
    const ctx = this.ctx;
    const { x, y, rx, ry } = shape;
    // Layered incandescent strands, each with a slowly moving irregular edge.
    for (let layer = 0; layer < 7; layer++) {
      ctx.beginPath();
      const steps = Math.max(2, Math.floor(180 * arc));
      for (let i = 0; i <= steps; i++) {
        const a = -Math.PI / 2 + (i / steps) * arc * TAU;
        const ripple = this.reduced ? 0 : Math.sin(a * 23 + age * 7 + layer) * 1.8 + Math.sin(a * 41 - age * 10) * 1.1;
        const offset = (layer - 3) * 1.2 + ripple;
        const px = x + Math.cos(a) * (rx + offset), py = y + Math.sin(a) * (ry + offset);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.lineWidth = [22, 13, 7, 3, 1.2, 1, .7][layer];
      ctx.strokeStyle = ['oklch(62% .22 40 / .08)', 'oklch(70% .2 50 / .16)', 'oklch(79% .18 65 / .4)',
        'oklch(89% .15 80)', 'oklch(98% .04 95)', 'oklch(93% .12 85 / .8)', 'oklch(82% .18 70 / .8)'][layer];
      ctx.stroke();
    }
  }

  private drawSparks(now: number) {
    if (this.reduced) { this.sparks = []; return; }
    this.sparks = this.sparks.filter(p => now - p.born < p.life);
    const ctx = this.ctx;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    // Six batched paths: hot cores and cooling orange tails, two width groups.
    for (let bucket = 0; bucket < 6; bucket++) {
      ctx.strokeStyle = ['oklch(97% .07 90 / .95)', 'oklch(87% .17 75 / .8)', 'oklch(68% .19 45 / .4)'][bucket % 3];
      ctx.lineWidth = bucket < 3 ? 1 : 1.8;
      ctx.beginPath();
      for (const p of this.sparks) {
        const age = (now - p.born) / p.life;
        if (Math.min(2, Math.floor(age * 3)) + (p.size > 1.6 ? 3 : 0) !== bucket) continue;
        const t = (now - p.born) / 1000, tail = Math.max(0, t - .022 - p.heat * .025);
        ctx.moveTo(p.x + p.vx * tail, p.y + p.vy * tail + 145 * tail * tail);
        ctx.lineTo(p.x + p.vx * t, p.y + p.vy * t + 145 * t * t);
      }
      ctx.stroke();
    }
    // A sparse subset carries halos, keeping draw calls and overdraw bounded.
    for (let i = 0; i < this.sparks.length; i += 18) {
      const p = this.sparks[i], t = (now - p.born) / 1000;
      ctx.globalAlpha = (1 - (now - p.born) / p.life) * .65;
      ctx.drawImage(this.glow, p.x + p.vx * t - 7, p.y + p.vy * t + 145 * t * t - 7, 14, 14);
    }
    ctx.restore();
  }
}
