import { describe, expect, it } from 'vitest';
import { portalPhase, PORTAL_DURATION } from '../effects/SlingRingEffect';
import { PORTAL, PortalGesture, type PortalSample } from '../input/portalGesture';

type Options = { direction?: number; duration?: number; radius?: number; turns?: number; start?: number;
  blocked?: boolean; shape?: 'line' | 'zigzag' | 'oval' | 'reverse'; gap?: number; swap?: boolean; fps?: number; jitter?: number };
function samples(options: Options = {}) {
  const { direction = 1, duration = 1800, radius = .2, turns = 1, start = 0, blocked = false } = options;
  const frames = Math.round(duration / 1000 * (options.fps ?? 30));
  return Array.from({ length: frames + 1 }, (_, i) => {
    const progress = i / frames;
    const angle = (options.shape === 'reverse' ? Math.min(progress, 1 - progress) : progress) * Math.PI * 2 * direction * turns;
    const sample: PortalSample = { x: .5 + Math.cos(angle) * radius, y: .5 + Math.sin(angle) * radius,
      present: !options.gap || Math.abs(progress * duration - duration / 2) > options.gap / 2,
      blocked, hand: options.swap && i >= frames / 2 ? 'L' : 'R' };
    if (options.shape === 'line') { sample.x = .2 + progress * .6; sample.y = .5; }
    if (options.shape === 'zigzag') { sample.x = .5 + Math.sin(angle * 4) * radius; sample.y = .5 + Math.sin(angle) * radius; }
    if (options.shape === 'oval') sample.y = .5 + Math.sin(angle) * radius * .55;
    sample.x += Math.sin(i * 2.3) * (options.jitter ?? 0);
    sample.y += Math.cos(i * 1.7) * (options.jitter ?? 0);
    return { t: start + progress * duration, sample };
  });
}
function trace(gesture: PortalGesture, options: Options = {}) {
  return samples(options).filter(({ t, sample }) => gesture.step(t, sample));
}

describe('forgiving, deliberate portal circles', () => {
  it('summons with one relaxed circle in either direction, including a natural oval', () => {
    for (const options of [{}, { direction: -1 }, { shape: 'oval' as const, duration: 3400 }, { duration: 4000 }, { radius: .12 }]) {
      expect(trace(new PortalGesture(), options), JSON.stringify(options)).toHaveLength(1);
    }
  });
  it('lights feedback before completion without requiring a second circle', () => {
    const gesture = new PortalGesture();
    expect(trace(gesture, { turns: .8, duration: 1500 })).toHaveLength(0);
    expect(gesture.armed).toBe(true);
    expect(trace(new PortalGesture(), { turns: .92 })).toHaveLength(1);
  });
  it('ignores the lead-in reach when the user moves into position then draws a circle', () => {
    const gesture = new PortalGesture();
    for (let t = 0; t <= 500; t += 25) expect(gesture.step(t, { x: .5 + t / 2500, y: .5, hand: 'R', present: true, blocked: false })).toBe(false);
    expect(trace(gesture, { start: 525 })).toHaveLength(1);
  });
  it('tolerates a briefly blurred frame without inventing movement, but resets after prolonged loss', () => {
    expect(trace(new PortalGesture(), { gap: 100 })).toHaveLength(1);
    expect(trace(new PortalGesture(), { gap: 600 })).toHaveLength(0);
    const gesture = new PortalGesture();
    trace(gesture, { turns: .8, duration: 1500 });
    expect(gesture.armed).toBe(true);
    gesture.step(1500 + PORTAL.gapMs + 1, { x: 0, y: 0, hand: '', present: false, blocked: false });
    expect(gesture.armed).toBe(false);
  });
  it('accepts ordinary camera noise at 10, 15 and 30 fps', () => {
    for (const fps of [10, 15, 30]) expect(trace(new PortalGesture(), { fps, jitter: .006 })).toHaveLength(1);
  });
  it('rejects swipes, zigzags, out-and-back arcs, small tremors and incomplete or rushed circles', () => {
    for (const options of [{ shape: 'line' as const }, { shape: 'zigzag' as const }, { shape: 'reverse' as const },
      { radius: .035 }, { turns: .7 }, { duration: 300 }, { duration: 8000 }]) {
      expect(trace(new PortalGesture(), options), JSON.stringify(options)).toHaveLength(0);
    }
  });
  it('cancels pinches and hand changes during a circle', () => {
    for (const options of [{ blocked: true }, { swap: true }]) expect(trace(new PortalGesture(), options)).toHaveLength(0);
    const gesture = new PortalGesture();
    for (const { t, sample } of samples()) {
      expect(gesture.step(t, { ...sample, blocked: t > 800 && t < 1000 })).toBe(false);
    }
  });
  it('keeps the 12-second cooldown, including through reset, then allows another deliberate circle', () => {
    const gesture = new PortalGesture();
    expect(trace(gesture)).toHaveLength(1);
    gesture.reset();
    expect(trace(gesture, { start: 2000 })).toHaveLength(0);
    expect(trace(gesture, { start: 6000 })).toHaveLength(0);
    expect(trace(gesture, { start: PORTAL.cooldownMs + 2000 })).toHaveLength(1);
  });
  it('resets partial attempts and rejects invalid coordinates and abrupt tracking jumps', () => {
    const gesture = new PortalGesture();
    trace(gesture, { turns: .5 }); gesture.reset();
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
