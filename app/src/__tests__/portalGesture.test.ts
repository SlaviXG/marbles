import { describe, expect, it } from 'vitest';
import { PORTAL, PortalGesture, type PortalSample } from '../input/portalGesture';

function trace(gesture: PortalGesture, options: { direction?: number; duration?: number; radius?: number; turns?: number; start?: number; blocked?: boolean; shape?: 'line' | 'zigzag' | 'oval'; gap?: boolean; swap?: boolean } = {}) {
  const { direction = 1, duration = 1800, radius = .2, turns = 1, start = 0, blocked = false } = options;
  const triggers: number[] = [];
  for (let i = 0; i <= 60; i++) {
    const angle = i / 60 * Math.PI * 2 * direction * turns;
    const sample: PortalSample = { x: .5 + Math.cos(angle) * radius, y: .5 + Math.sin(angle) * radius,
      present: !options.gap || i !== 30, blocked, hand: options.swap && i >= 30 ? 'L' : 'R' };
    if (options.shape === 'line') { sample.x = .2 + i / 100; sample.y = .5; }
    if (options.shape === 'zigzag') { sample.x = .5 + Math.sin(angle * 4) * radius; sample.y = .5 + Math.sin(angle) * radius; }
    if (options.shape === 'oval') sample.y = .5 + Math.sin(angle) * radius * .7;
    if (gesture.step(start + i / 60 * duration, sample)) triggers.push(i);
  }
  return triggers;
}

describe('sling-ring circle recognition', () => {
  it('accepts a deliberate circle clockwise or counterclockwise and a natural oval', () => {
    expect(trace(new PortalGesture())).toHaveLength(1);
    expect(trace(new PortalGesture(), { direction: -1 })).toHaveLength(1);
    expect(trace(new PortalGesture(), { shape: 'oval', duration: 2600 })).toHaveLength(1);
  });
  it('rejects swipes, zigzags, small tremors, incomplete arcs, and implausibly fast or slow circles', () => {
    for (const options of [{ shape: 'line' as const }, { shape: 'zigzag' as const }, { radius: .035 }, { turns: .7 }, { duration: 300 }, { duration: 6000 }]) {
      expect(trace(new PortalGesture(), options), JSON.stringify(options)).toHaveLength(0);
    }
  });
  it('never joins different hands, lost tracking or a pinch/drag into a circle', () => {
    for (const options of [{ blocked: true }, { gap: true }, { swap: true }]) expect(trace(new PortalGesture(), options)).toHaveLength(0);
  });
  it('ignores repeat circles during cooldown, then allows another summon', () => {
    const gesture = new PortalGesture();
    expect(trace(gesture)).toHaveLength(1);
    expect(trace(gesture, { start: 2000 })).toHaveLength(0);
    expect(trace(gesture, { start: PORTAL.cooldownMs + 2000 })).toHaveLength(1);
  });
  it('resets partial circles and ignores invalid coordinates and tracking jumps', () => {
    const gesture = new PortalGesture();
    trace(gesture, { turns: .5 });
    gesture.reset();
    expect(trace(gesture, { turns: .5, start: 2000 })).toHaveLength(0);
    expect(gesture.step(4000, { x: NaN, y: .5, hand: 'R', present: true, blocked: false })).toBe(false);
    expect(trace(gesture, { start: 5000 })).toHaveLength(1);
    const jump = new PortalGesture();
    for (let i = 0; i <= 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      expect(jump.step(i * 170, { x: .5 + .2 * Math.cos(angle), y: .5 + .2 * Math.sin(angle), hand: 'R', present: true, blocked: false })).toBe(false);
    }
  });
});
