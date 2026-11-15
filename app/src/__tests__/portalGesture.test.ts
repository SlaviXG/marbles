import { describe, expect, it } from 'vitest';
import { portalPhase, PORTAL_DURATION } from '../effects/SlingRingEffect';
import { PORTAL, PortalGesture, type PortalSample } from '../input/portalGesture';

function trace(gesture: PortalGesture, options: { direction?: number; duration?: number; radius?: number; turns?: number; start?: number; blocked?: boolean; shape?: 'line' | 'zigzag' | 'oval'; gap?: boolean; swap?: boolean; fps?: number; jitter?: number } = {}) {
  const { direction = 1, duration = 3600, radius = .2, turns = 2, start = 0, blocked = false } = options;
  const triggers: number[] = [];
  const frames = Math.round(duration / 1000 * (options.fps ?? 30));
  for (let i = 0; i <= frames; i++) {
    const angle = i / frames * Math.PI * 2 * direction * turns;
    const sample: PortalSample = { x: .5 + Math.cos(angle) * radius, y: .5 + Math.sin(angle) * radius,
      present: !options.gap || i !== Math.floor(frames / 2), blocked, hand: options.swap && i >= frames / 2 ? 'L' : 'R' };
    if (options.shape === 'line') { sample.x = .2 + i / 100; sample.y = .5; }
    if (options.shape === 'zigzag') { sample.x = .5 + Math.sin(angle * 4) * radius; sample.y = .5 + Math.sin(angle) * radius; }
    if (options.shape === 'oval') sample.y = .5 + Math.sin(angle) * radius * .7;
    sample.x += Math.sin(i * 2.3) * (options.jitter ?? 0);
    sample.y += Math.cos(i * 1.7) * (options.jitter ?? 0);
    if (gesture.step(start + i / frames * duration, sample)) triggers.push(i);
  }
  return triggers;
}

describe('sling-ring circle recognition', () => {
  it('requires two deliberate circles, clockwise or counterclockwise, including natural ovals', () => {
    expect(trace(new PortalGesture())).toHaveLength(1);
    expect(trace(new PortalGesture(), { direction: -1 })).toHaveLength(1);
    expect(trace(new PortalGesture(), { shape: 'oval', duration: 5200 })).toHaveLength(1);
  });
  it('arms after one circle but never summons from a single loop', () => {
    const gesture = new PortalGesture();
    expect(trace(gesture, { turns: 1, duration: 1800 })).toHaveLength(0);
    expect(gesture.armed).toBe(true);
    expect(trace(gesture, { turns: 1, duration: 1800, start: 1800 })).toHaveLength(1);
    expect(gesture.armed).toBe(false);
  });
  it('cancels arming after a pause, pinch, reversal or hand change', () => {
    for (const kind of ['pause', 'pinch', 'reverse', 'hand'] as const) {
      const gesture = new PortalGesture();
      trace(gesture, { turns: 1, duration: 1800 });
      if (kind === 'pinch' || kind === 'hand') gesture.step(1810, { x: .7, y: .5, present: true, blocked: kind === 'pinch', hand: kind === 'hand' ? 'L' : 'R' });
      expect(trace(gesture, { turns: 1, duration: 1800, start: kind === 'pause' ? 6000 : 1820, direction: kind === 'reverse' ? -1 : 1 }), kind).toHaveLength(0);
    }
  });
  it('accepts modest camera noise at 15 and 30 fps without counting a single loop twice', () => {
    for (const fps of [15, 30]) {
      expect(trace(new PortalGesture(), { fps, jitter: .002 })).toHaveLength(1);
      expect(trace(new PortalGesture(), { fps, jitter: .002, turns: 1, duration: 1800 })).toHaveLength(0);
    }
  });
  it('rejects swipes, zigzags, small tremors, incomplete arcs, and implausibly fast or slow circles', () => {
    for (const options of [{ shape: 'line' as const }, { shape: 'zigzag' as const }, { radius: .035 }, { turns: .7 }, { duration: 300 }, { duration: 12000 }]) {
      expect(trace(new PortalGesture(), options), JSON.stringify(options)).toHaveLength(0);
    }
  });
  it('never joins different hands, lost tracking or a pinch/drag into a circle', () => {
    for (const options of [{ blocked: true }, { gap: true }, { swap: true }]) expect(trace(new PortalGesture(), options)).toHaveLength(0);
  });
  it('ignores repeat circles during cooldown, then allows another summon', () => {
    const gesture = new PortalGesture();
    expect(trace(gesture)).toHaveLength(1);
    expect(trace(gesture, { start: 4000 })).toHaveLength(0);
    expect(trace(gesture, { start: PORTAL.cooldownMs + 4000 })).toHaveLength(1);
  });
  it('resets partial circles and ignores invalid coordinates and tracking jumps', () => {
    const gesture = new PortalGesture();
    trace(gesture, { turns: .5 });
    gesture.reset();
    expect(trace(gesture, { turns: .5, start: 2000 })).toHaveLength(0);
    expect(gesture.step(4000, { x: NaN, y: .5, hand: 'R', present: true, blocked: false })).toBe(false);
    expect(trace(gesture, { start: 6000 })).toHaveLength(1);
    const jump = new PortalGesture();
    for (let i = 0; i <= 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      expect(jump.step(i * 170, { x: .5 + .2 * Math.cos(angle), y: .5 + .2 * Math.sin(angle), hand: 'R', present: true, blocked: false })).toBe(false);
    }
  });
});

it('plays drawing, opening, arrival, closing and embers before becoming idle', () => {
  expect([0, 1800, 3000, 6300, 7400, PORTAL_DURATION].map(portalPhase)).toEqual(['drawing', 'opening', 'arrival', 'closing', 'embers', 'idle']);
});
