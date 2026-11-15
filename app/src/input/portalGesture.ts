// Raw, mirrored camera coordinates, before cursor gain, magnets or smoothing.
// A deliberate near-complete circle summons a cameo, never a pointer action.
export type PortalSample = { x: number; y: number; hand: string; present: boolean; blocked: boolean };
export type PortalPoint = { x: number; y: number; t: number };
export const PORTAL = { minMs: 650, maxMs: 4200, gapMs: 300, cooldownMs: 12000, minDiameter: .18 };

export class PortalGesture {
  private points: PortalPoint[] = [];
  private drawing: PortalPoint[] = [];
  private hand = '';
  private lastSeen = -Infinity;
  private quietUntil = -Infinity;

  // Visible feedback begins late in a plausible circle, before it closes.
  get armed(): boolean { return this.drawing.length > 0; }
  get trail(): readonly PortalPoint[] { return this.drawing.length ? this.drawing : this.points; }
  reset() { this.points = []; this.drawing = []; this.hand = ''; this.lastSeen = -Infinity; }

  step(now: number, sample: PortalSample): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)
      || sample.blocked || now < this.quietUntil) { this.reset(); return false; }
    // A blurred frame is common while circling. Keep the real observations for
    // a short grace period; never interpolate or count movement while absent.
    if (!sample.present) {
      if (now - this.lastSeen > PORTAL.gapMs) this.reset();
      return false;
    }
    if (sample.hand !== this.hand || now - this.lastSeen > PORTAL.gapMs || now < this.lastSeen) this.reset();
    this.hand = sample.hand;
    this.lastSeen = now;
    this.points = this.points.filter(p => now - p.t <= PORTAL.maxMs);
    const last = this.points[this.points.length - 1];
    if (last && Math.hypot(sample.x - last.x, sample.y - last.y) < .008) {
      if (now - last.t > 450) this.drawing = [];
      return false;
    }
    this.points.push({ x: sample.x, y: sample.y, t: now });
    if (this.points.length > 180) this.points.shift();
    this.drawing = [];

    // Try suffixes so moving into position before the circle does not poison
    // recognition for an entire time window. History is capped at 180 points.
    for (let start = 0; start <= this.points.length - 12; start++) {
      const points = this.points.slice(start);
      if (now - points[0].t < PORTAL.minMs) break;
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const w = x1 - x0, h = y1 - y0;
      if (Math.min(w, h) < PORTAL.minDiameter || w / h < .45 || w / h > 2.2) continue;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, radius = (w + h) / 4;
      let turn = 0, absoluteTurn = 0, travel = 0, valid = true;
      for (let i = 0; i < points.length; i++) {
        const p = points[i], distance = Math.hypot(p.x - cx, p.y - cy);
        if (distance < radius * .38 || distance > radius * 1.65) { valid = false; break; }
        if (!i) continue;
        const previous = points[i - 1];
        const angle = Math.atan2(p.y - cy, p.x - cx) - Math.atan2(previous.y - cy, previous.x - cx);
        const delta = Math.atan2(Math.sin(angle), Math.cos(angle));
        if (Math.abs(delta) > .8) { valid = false; break; }
        turn += delta; absoluteTurn += Math.abs(delta);
        travel += Math.hypot(p.x - previous.x, p.y - previous.y);
      }
      if (!valid || absoluteTurn === 0 || Math.abs(turn) / absoluteTurn < .82 || travel > radius * 9) continue;
      if (Math.abs(turn) >= Math.PI * 1.35 && !this.drawing.length) this.drawing = points;
      if (Math.abs(turn) < Math.PI * 1.75 || travel < radius * 4.8
        || Math.hypot(sample.x - points[0].x, sample.y - points[0].y) > radius * .75) continue;
      this.quietUntil = now + PORTAL.cooldownMs;
      this.reset();
      return true;
    }
    return false;
  }
}
