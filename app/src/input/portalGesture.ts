// Raw, mirrored camera coordinates, before cursor gain, magnets or smoothing.
// Two closed loops in the same direction summon a cameo, never a pointer action.
export type PortalSample = { x: number; y: number; hand: string; present: boolean; blocked: boolean };
export type PortalPoint = { x: number; y: number; t: number };
type Point = PortalPoint;
export const PORTAL = { minMs: 800, maxMs: 3200, gapMs: 180, cooldownMs: 12000, minDiameter: .22, confirmMs: 3600 };

export class PortalGesture {
  private points: Point[] = [];
  private hand = '';
  private lastSeen = -Infinity;
  private quietUntil = -Infinity;
  private firstCircle: { x: number; y: number; radius: number; direction: number; at: number } | null = null;

  get armed(): boolean { return this.firstCircle !== null; }

  get trail(): readonly PortalPoint[] { return this.points; }

  reset() { this.points = []; this.hand = ''; this.lastSeen = -Infinity; this.firstCircle = null; }

  step(now: number, sample: PortalSample): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)
      || !sample.present || sample.blocked || now < this.quietUntil) { this.reset(); return false; }
    if (sample.hand !== this.hand || now - this.lastSeen > PORTAL.gapMs || now < this.lastSeen) this.reset();
    this.hand = sample.hand;
    this.lastSeen = now;
    if (this.firstCircle && now - this.firstCircle.at > PORTAL.confirmMs) this.firstCircle = null;
    this.points = this.points.filter(p => now - p.t <= PORTAL.maxMs);
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(sample.x - last.x, sample.y - last.y) < .008) return false;
    this.points.push({ x: sample.x, y: sample.y, t: now });
    // Bounded by the time window and distance floor, even on a fast camera.
    if (this.points.length > 180) this.points.shift();
    const points = this.points;
    if (points.length < 16 || now - points[0].t < PORTAL.minMs) return false;
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) < PORTAL.minDiameter || w / h < .55 || w / h > 1.8) return false;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const radius = (w + h) / 4;
    if (Math.hypot(sample.x - points[0].x, sample.y - points[0].y) > radius * .5) return false;
    let turn = 0, absoluteTurn = 0, travel = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const distance = Math.hypot(p.x - cx, p.y - cy);
      if (distance < radius * .5 || distance > radius * 1.5) return false;
      if (!i) continue;
      const previous = points[i - 1];
      const delta = Math.atan2(Math.sin(Math.atan2(p.y - cy, p.x - cx) - Math.atan2(previous.y - cy, previous.x - cx)),
        Math.cos(Math.atan2(p.y - cy, p.x - cx) - Math.atan2(previous.y - cy, previous.x - cx)));
      // Reject a tracking jump rather than filling in an unseen arc.
      if (Math.abs(delta) > .65) return false;
      turn += delta; absoluteTurn += Math.abs(delta);
      travel += Math.hypot(p.x - previous.x, p.y - previous.y);
    }
    if (Math.abs(turn) < Math.PI * 1.8 || Math.abs(turn) / absoluteTurn < .88
      || travel < radius * 5 || travel > radius * 8) return false;
    const first = this.firstCircle;
    const direction = Math.sign(turn);
    const confirmed = !!first && direction === first.direction
      && Math.hypot(cx - first.x, cy - first.y) < first.radius * .55
      && radius / first.radius > .65 && radius / first.radius < 1.5;
    if (confirmed) {
      this.quietUntil = now + PORTAL.cooldownMs;
      this.reset();
      return true;
    }
    // A single accidental loop only arms. Start a fresh loop at this endpoint;
    // overlapping points cannot count the same revolution twice.
    this.firstCircle = { x: cx, y: cy, radius, direction, at: now };
    this.points = [{ x: sample.x, y: sample.y, t: now }];
    return false;
  }
}
