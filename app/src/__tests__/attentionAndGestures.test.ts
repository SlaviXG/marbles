import { describe, expect, it } from 'vitest';
import { DismissGesture } from '../input/dismissGesture';
import { AttentionFilter, closestFace, facing, poseFromMatrix } from '../attention/headPose';
import { AudioTurns, BACKGROUND_SECONDS, SAMPLE_RATE } from '../voice/audio';

const view = { width: 1440, height: 900 };
const hand = (x: number, y: number, extra = {}) => ({ x, y, present: true, pinching: false, ...extra });
const gone = { x: 0, y: 0, present: false, pinching: false };

describe('dropping your hands', () => {
  const drop = (frames: (t: number) => ReturnType<typeof hand> | typeof gone, until: number) => {
    const gesture = new DismissGesture();
    let event = null;
    for (let t = 0; t <= until && !event; t += 16) event = gesture.step(t, frames(t), view);
    return event;
  };
  // In view for a second, then straight down and out at speed.
  const falling = (t: number) => t <= 1000 ? hand(700, 400) : t <= 1160 ? hand(700, 400 + (t - 1000) * 2.6) : gone;
  it('clears the stage when the hand falls out of view', () => {
    expect(drop(falling, 2200)).toEqual({ type: 'drop' });
  });
  it('does nothing when hands are lowered at ordinary speed, rested low, or only flicker', () => {
    expect(drop(t => t <= 1000 ? hand(700, 400) : t <= 1600 ? hand(700, 400 + (t - 1000) * .7) : gone, 2800)).toBeNull(); // slow
    expect(drop(t => t <= 1200 ? hand(700, 800) : gone, 2400)).toBeNull(); // resting low, then lost
    expect(drop(t => falling(t) === gone && t > 1400 ? hand(700, 700) : falling(t), 2600)).toBeNull(); // came straight back
  });
  it('does nothing for a sideways exit, a brief appearance, or letting go of a pinch', () => {
    expect(drop(t => t <= 1000 ? hand(700, 700) : t <= 1160 ? hand(700 + (t - 1000) * 3, 700 + (t - 1000) * .6) : gone, 2200)).toBeNull();
    expect(drop(t => t <= 300 ? hand(700, 400) : t <= 460 ? hand(700, 400 + (t - 300) * 2.6) : gone, 1600)).toBeNull();
    expect(drop(t => t <= 1000 ? hand(700, 400, { pinching: true }) : t <= 1160 ? hand(700, 400 + (t - 1000) * 2.6, { pinching: true }) : gone, 2200)).toBeNull();
  });
});

// A rotation about the vertical axis by `yaw`, then about the horizontal by `pitch`, column-major.
function matrix(yawDeg: number, pitchDeg: number) {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  const forward = [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
  return [1, 0, 0, 0, 0, 1, 0, 0, ...forward, 0, 0, 0, -50, 1];
}

describe('who is looking at the screen', () => {
  it('reads yaw and pitch from the face matrix', () => {
    expect(poseFromMatrix(matrix(0, 0))).toEqual({ yaw: 0, pitch: 0 });
    const turned = poseFromMatrix(matrix(40, 10));
    expect(turned.yaw).toBeCloseTo(40, 3); expect(turned.pitch).toBeCloseTo(10, 3);
    expect(facing(poseFromMatrix(matrix(10, -8)))).toBe(true);
    expect(facing(poseFromMatrix(matrix(40, 0)))).toBe(false);
    expect(facing(poseFromMatrix(matrix(0, 35)))).toBe(false);
  });
  it('attends to the nearest (largest) face', () => {
    expect(closestFace([{ size: .12, id: 'far' }, { size: .31, id: 'near' }, { size: .2, id: 'mid' }])?.id).toBe('near');
    expect(closestFace([])).toBeNull();
  });
  it('needs a steady look to engage and a real look away to release', () => {
    const filter = new AttentionFilter();
    const ahead = { yaw: 3, pitch: -4 }, aside = { yaw: 50, pitch: 0 }, nod = { yaw: 27, pitch: 0 };
    expect(filter.update(0, ahead)).toBe('nobody');
    expect(filter.update(200, ahead)).toBe('nobody');
    expect(filter.update(350, ahead)).toBe('looking');
    expect(filter.update(500, nod)).toBe('looking'); // inside the wider release cone
    expect(filter.update(600, aside)).toBe('looking'); // a glance
    expect(filter.update(1000, ahead)).toBe('looking');
    expect(filter.update(1100, aside)).toBe('looking');
    expect(filter.update(2600, aside)).toBe('looking'); // not long enough yet
    expect(filter.update(3000, aside)).toBe('away');
    expect(filter.update(3100, null)).toBe('away');
    expect(filter.update(6000, null)).toBe('nobody');
  });
});

describe('telling speech from background sound', () => {
  const chunk = (level: number, seconds = 2048 / SAMPLE_RATE) => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => Math.sin(i * .3) * level * Math.SQRT2);
  it('gives up on sound that never pauses and stops reacting to it', () => {
    const turns = new AudioTurns();
    for (let i = 0; i < 8; i++) turns.push(chunk(.002)); // quiet room
    let background = false, seconds = 0;
    while (!background && seconds < BACKGROUND_SECONDS + 2) { background = !!turns.push(chunk(.08)).background; seconds += 2048 / SAMPLE_RATE; }
    expect(background).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(BACKGROUND_SECONDS - .1);
    // The same music afterwards no longer opens a turn...
    let reopened = false;
    for (let i = 0; i < 60; i++) reopened ||= turns.push(chunk(.08)).speaking;
    expect(reopened).toBe(false);
    // ...but someone speaking over it does.
    let heard = false;
    for (let i = 0; i < 8; i++) heard ||= turns.push(chunk(.3)).speaking;
    expect(heard).toBe(true);
  });
  it('lets ordinary speech through, pauses and all', () => {
    const turns = new AudioTurns();
    for (let i = 0; i < 8; i++) turns.push(chunk(.002));
    let background = false, committed = false;
    for (let phrase = 0; phrase < 6; phrase++) {
      for (let i = 0; i < 9; i++) background ||= !!turns.push(chunk(.09)).background; // ~0.8 s of words
      for (let i = 0; i < 3; i++) { const turn = turns.push(chunk(.002)); background ||= !!turn.background; committed ||= turn.commit; } // a breath
    }
    expect(background).toBe(false);
  });
});
