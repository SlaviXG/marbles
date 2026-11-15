import { afterEach, describe, expect, it } from 'vitest';
import { DismissGesture, openPalm } from '../input/dismissGesture';
import { applyDisplayAction } from '../state/windows';
import { useDisplay } from '../state/display';
import { useVault } from '../state/store';
import { mediaCommand } from '../voice/mediaCommand';

const view = { width: 1440, height: 900 };
function sweep({ open = true, dwell = true, pinching = false, speed = 2, target = 'video', reverse = false } = {}) {
  const gesture = new DismissGesture();
  const hand = (x: number, target: string | null) => ({ x, y: 400, target, open, pinching, present: true });
  if (dwell) for (let t = 0; t <= 300; t += 20) gesture.step(t, hand(500, target), view);
  let result = null;
  for (let t = 320; t <= 600 && !result; t += 40) result = gesture.step(t,
    hand(500 + (reverse ? -1 : 1) * (t - 300) * speed, t <= 340 ? target : null), view);
  return { gesture, result };
}
describe('deliberate open-palm swishes', () => {
  it('closes just the aimed window in either direction, without a grip', () => {
    expect(sweep().result).toEqual({ type: 'swipe', target: 'video', direction: 1 });
    expect(sweep({ target: 'selection', reverse: true }).result).toEqual({ type: 'swipe', target: 'selection', direction: -1 });
  });
  it('rejects pointing, slow reaching, an unarmed pass, a pinch, and the empty canvas', () => {
    for (const options of [{ open: false }, { speed: .4 }, { dwell: false }, { pinching: true }, { target: '' }]) expect(sweep(options).result).toBeNull();
  });
  it('disarms on tracking loss and cannot close a second window in the same sweep', () => {
    const { gesture, result } = sweep(); expect(result?.type).toBe('swipe');
    for (let t = 500; t <= 900; t += 40) expect(gesture.step(t, { x: t * 2, y: 400, target: 'media', open: true, present: true, pinching: false }, view)).toBeNull();
    const next = new DismissGesture();
    for (let t = 0; t <= 300; t += 20) next.step(t, { x: 400, y: 400, target: 'video', open: true, present: true, pinching: false }, view);
    next.step(480, { x: 400, y: 400, present: false, pinching: false }, view);
    expect(next.armedTarget).toBeNull();
  });
  it('distinguishes an open palm from a pointing index finger', () => {
    const pts = new Array(42).fill(0);
    for (const tip of [8, 12, 16, 20]) { pts[(tip - 2) * 2 + 1] = .3; pts[tip * 2 + 1] = .55; }
    expect(openPalm(pts)).toBe(true);
    for (const tip of [12, 16, 20]) pts[tip * 2 + 1] = .2;
    expect(openPalm(pts)).toBe(false);
    expect(openPalm([])).toBe(false);
  });
  it('continues a deliberate sweep across a brief blurred frame without inventing movement', () => {
    const gesture = new DismissGesture();
    for (let t = 0; t <= 300; t += 20) gesture.step(t, { x: 500, y: 400, target: 'video', open: true, present: true, pinching: false }, view);
    expect(gesture.step(340, { x: 580, y: 400, target: 'video', open: true, present: true, pinching: false }, view)).toBeNull();
    expect(gesture.step(380, { x: 580, y: 400, present: false, pinching: false }, view)).toBeNull();
    expect(gesture.step(420, { x: 740, y: 400, target: null, open: true, present: true, pinching: false }, view)).toEqual({ type: 'swipe', target: 'video', direction: 1 });
  });
  it('rejects diagonal reaches and small fast tremors even after arming', () => {
    for (const diagonal of [true, false]) {
      const gesture = new DismissGesture();
      for (let t = 0; t <= 300; t += 20) gesture.step(t, { x: 500, y: 400, target: 'video', open: true, present: true, pinching: false }, view);
      for (let t = 340; t <= 620; t += 40) expect(gesture.step(t, { x: 500 + (diagonal ? (t - 300) * 2 : Math.sin(t) * 40), y: diagonal ? 400 + (t - 300) * 2 : 400, target: 'video', open: true, present: true, pinching: false }, view)).toBeNull();
    }
  });
});

afterEach(() => { useDisplay.getState().close(); useDisplay.getState().closeVideo(); useVault.getState().clear(); });
it('applies Hermes close receipts to the separate video, preview, gallery or every window', () => {
  const setup = () => {
    useDisplay.getState().show({ kind: 'video', videoId: 'fixture', title: 'Video', channel: '', query: 'fixture' });
    useDisplay.getState().show({ kind: 'images', query: 'fixture', images: [] });
    useVault.getState().select('agent:claude');
  };
  setup(); applyDisplayAction({ kind: 'close', target: 'video' });
  expect(useDisplay.getState().video).toBeNull(); expect(useDisplay.getState().display).not.toBeNull(); expect(useVault.getState().selectedId).toBe('agent:claude');
  setup(); applyDisplayAction({ kind: 'close', target: 'selection' });
  expect(useVault.getState().selectedId).toBeNull(); expect(useDisplay.getState().video).not.toBeNull();
  setup(); applyDisplayAction({ kind: 'close' });
  expect(useVault.getState().selectedId).toBeNull(); expect(useDisplay.getState().video).toBeNull(); expect(useDisplay.getState().display).toBeNull();
});
it('understands natural YouTube and close-everything commands without swallowing unrelated speech', () => {
  for (const phrase of ['Close YouTube', 'Can you please close the YouTube video window for me?', 'get rid of that video']) expect(mediaCommand(phrase, null, true)?.action).toBe('closeVideo');
  expect(mediaCommand('close all windows', null)?.action).toBe('closeAll');
  expect(mediaCommand('explain how to close a YouTube video', null, true)).toBeNull();
});
