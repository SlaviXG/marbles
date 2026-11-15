// Raw, mirrored camera coordinates, before cursor gain, magnets or smoothing.
// A closed loop in either direction summons a cameo, never a pointer action.
export type PortalSample = { x: number; y: number; hand: string; present: boolean; blocked: boolean };
type Point = { x: number; y: number; t: number };
export const PORTAL = { minMs: 650, maxMs: 3200, gapMs: 180, cooldownMs: 8000, minDiameter: .18 };

export class PortalGesture {
  private points: Point[] = [];
  private hand = '';
  private lastSeen = -Infinity;
  private quietUntil = -Infinity;

  reset() { this.points = []; this.hand = ''; this.lastSeen = -Infinity; }

  step(now: number, sample: PortalSample): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)
      || !sample.present || sample.blocked || now < this.quietUntil) { this.reset(); return false; }
    if (sample.hand !== this.hand || now - this.lastSeen > PORTAL.gapMs || now < this.lastSeen) this.reset();
    this.hand = sample.hand;
    this.lastSeen = now;
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
    this.quietUntil = now + PORTAL.cooldownMs;
    this.reset();
    return true;
  }
}
