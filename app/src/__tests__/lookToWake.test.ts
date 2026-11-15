import { afterEach, describe, expect, it, vi } from 'vitest';
import { LookToWake, lookToWakePermitted } from '../attention/LookToWake';

afterEach(() => vi.unstubAllGlobals());
const observe = (gate: LookToWake, at: number, looking = true, visible = true) => gate.observe({ at, looking }, at, visible);

describe('look to wake at startup', () => {
  it('requires a fresh, continuous look and activates only once', () => {
    const gate = new LookToWake();
    for (const at of [0, 260, 520, 780, 1040]) expect(observe(gate, at)).toBe(false);
    expect(observe(gate, 1300)).toBe(true);
    expect(gate.available).toBe(false);
    for (const at of [1560, 1820, 2080, 2340, 2600]) expect(observe(gate, at)).toBe(false);
  });
  it('does not turn a glance, stale frame, missing face or hidden page into startup', () => {
    const gate = new LookToWake();
    observe(gate, 0); observe(gate, 260);
    expect(observe(gate, 520, false)).toBe(false);
    expect(observe(gate, 780)).toBe(false);
    expect(gate.observe({ at: 780, looking: true }, 2100, true)).toBe(false);
    expect(observe(gate, 2200)).toBe(false);
    expect(gate.observe(null, 2460, true)).toBe(false);
    expect(observe(gate, 2600)).toBe(false);
    expect(observe(gate, 2860, true, false)).toBe(false);
    expect(observe(gate, 3120)).toBe(false);
    expect(observe(gate, 3380)).toBe(false);
  });
  it('cannot be reactivated by looking after manual start, pause, cancel or a failed attempt', () => {
    const gate = new LookToWake();
    observe(gate, 0); gate.cancel(); gate.resetLook();
    for (let at = 260; at < 5000; at += 260) expect(observe(gate, at)).toBe(false);
  });
  it('restarts the dwell when camera observations stall', () => {
    const gate = new LookToWake();
    observe(gate, 0); observe(gate, 260); observe(gate, 520);
    expect(observe(gate, 2000)).toBe(false);
    for (const at of [2260, 2520, 2780, 3040]) expect(observe(gate, at)).toBe(false);
    expect(observe(gate, 3300)).toBe(true);
  });
});

describe('startup permissions', () => {
  it.each([['granted', 'granted', true], ['prompt', 'granted', false], ['granted', 'prompt', false], ['denied', 'granted', false], ['granted', 'denied', false]])(
    'requires existing camera=%s and microphone=%s permissions', async (camera, microphone, expected) => {
      const getUserMedia = vi.fn();
      vi.stubGlobal('isSecureContext', true);
      vi.stubGlobal('navigator', { mediaDevices: { getUserMedia }, permissions: { query: vi.fn(async ({ name }) => ({ state: name === 'camera' ? camera : microphone })) } });
      expect(await lookToWakePermitted()).toBe(expected);
      expect(getUserMedia).not.toHaveBeenCalled(); // Checking never prompts or captures.
    });
  it('falls back to the orb when permissions cannot be queried', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() }, permissions: { query: () => Promise.reject(new Error('unsupported')) } });
    expect(await lookToWakePermitted()).toBe(false);
  });
});
