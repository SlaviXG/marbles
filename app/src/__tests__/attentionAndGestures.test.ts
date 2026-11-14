import { describe, expect, it } from 'vitest';
import { DismissGesture } from '../input/dismissGesture';
import { AttentionFilter, closestFace, facing, poseFromMatrix } from '../attention/headPose';
import { AudioTurns, BACKGROUND_SECONDS, SAMPLE_RATE } from '../voice/audio';

const view = { width: 1440, height: 900 };
const hand = (x: number, y: number, extra = {}) => ({ x, y, present: true, pinching: false, ...extra });
const gone = { x: 0, y: 0, present: false, pinching: false };

describe('waving things away', () => {
  it('reads a quick sideways sweep as a swipe and reports where it travelled', () => {
    const gesture = new DismissGesture();
    let event: any = null;
    for (let i = 0; i <= 12 && !event; i++) event = gesture.step(1000 + i * 16, hand(400 + i * 45, 300 + i * 2), view);
    expect(event).toMatchObject({ type: 'swipe', direction: 1 });
    expect(event.path[0]).toEqual({ x: 400, y: 300 });
  });
  it('still sees a slap when tracking loses the hand in the middle of it', () => {
    const gesture = new DismissGesture();
    for (let t = 0; t <= 400; t += 66) gesture.step(t, hand(500, 400), view); // resting, at camera rate
    gesture.step(466, hand(540, 400), view);
    for (let t = 482; t < 700; t += 16) expect(gesture.step(t, gone, view)).toBeNull(); // blurred: no detection
    expect(gesture.step(700, hand(1020, 420), view)).toMatchObject({ type: 'swipe', direction: 1 });
  });
  it('counts a hand swept right out of view', () => {
    const gesture = new DismissGesture();
    for (let t = 0; t <= 400; t += 66) gesture.step(t, hand(1000, 400), view);
    // One more detection near the right edge, too short a move to count on its own, then gone.
    expect(gesture.step(466, hand(1180, 402), view)).toBeNull();
    let event = null;
    for (let t = 482; t < 700 && !event; t += 16) event = gesture.step(t, gone, view);
    expect(event).toMatchObject({ type: 'swipe', direction: 1 });
  });
  it('forgives a pinch that only flickers during the sweep', () => {
    const gesture = new DismissGesture();
    let event = null;
    for (let i = 0; i <= 12 && !event; i++) event = gesture.step(1000 + i * 16, hand(400 + i * 45, 300, { pinching: i === 4 || i === 5 }), view);
    expect(event).toMatchObject({ type: 'swipe' });
  });
  it('ignores slow travel, diagonal reaches and anything done while dragging', () => {
    const slow = new DismissGesture();
    for (let i = 0; i <= 80; i++) expect(slow.step(1000 + i * 16, hand(300 + i * 8, 300), view)).toBeNull();
    const diagonal = new DismissGesture();
    for (let i = 0; i <= 12; i++) expect(diagonal.step(1000 + i * 16, hand(400 + i * 45, 300 + i * 40), view)).toBeNull();
    const dragging = new DismissGesture();
    for (let i = 0; i <= 30; i++) expect(dragging.step(1000 + i * 16, hand(200 + i * 30, 300, { pinching: true }), view)).toBeNull();
    const small = new DismissGesture();
    for (let i = 0; i <= 4; i++) expect(small.step(1000 + i * 16, hand(400 + i * 40, 300), view)).toBeNull(); // quick but short: a flick of the wrist
  });
  it('closes the stage when the hand drops out of view, but not when it rests or flickers', () => {
    const drop = new DismissGesture();
    let t = 0;
    for (; t <= 700; t += 16) drop.step(t, hand(700, 400), view);
    for (let i = 0; i < 10; i++, t += 16) drop.step(t, hand(700, 400 + i * 45), view);
    let event = null;
    for (let i = 0; i < 40 && !event; i++, t += 16) event = drop.step(t, gone, view);
    expect(event).toEqual({ type: 'drop' });

    const rest = new DismissGesture();
    t = 0;
    for (; t <= 700; t += 16) rest.step(t, hand(700, 760), view);
    for (let i = 0; i < 60; i++, t += 16) expect(rest.step(t, gone, view)).toBeNull();

    const flicker = new DismissGesture();
    t = 0;
    for (; t <= 700; t += 16) flicker.step(t, hand(700, 400), view);
    for (let i = 0; i < 10; i++, t += 16) flicker.step(t, hand(700, 400 + i * 45), view);
    for (let i = 0; i < 10; i++, t += 16) expect(flicker.step(t, gone, view)).toBeNull();
    for (let i = 0; i < 60; i++, t += 16) expect(flicker.step(t, hand(700, 700), view)).toBeNull();
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
    expect(filter.update(2600, aside)).toBe('away');
    expect(filter.update(2700, null)).toBe('away');
    expect(filter.update(5000, null)).toBe('nobody');
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
