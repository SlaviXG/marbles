import { afterEach, expect, it, vi } from 'vitest';
import { VirtualPointer } from '../virtualPointer';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  class Pointer extends Event {
    clientX: number; clientY: number; buttons: number;
    constructor(type: string, init: any) { super(type, { cancelable: true }); this.clientX = init.clientX; this.clientY = init.clientY; this.buttons = init.buttons; }
  }
  class Surface extends EventTarget { isConnected = true; }
  const original = new Surface(), other = new Surface(), win = new Surface();
  let hit: Surface | null = original;
  vi.stubGlobal('PointerEvent', Pointer); vi.stubGlobal('MouseEvent', Pointer); vi.stubGlobal('window', win);
  vi.stubGlobal('document', { elementFromPoint: () => hit });
  return { pointer: new VirtualPointer(), original, other, win, hit: (value: Surface | null) => { hit = value; } };
}
it('keeps moves and release on the grabbed object across a different window or viewport edge', () => {
  const r = setup(), move = vi.fn(), up = vi.fn(), wrong = vi.fn();
  r.original.addEventListener('pointermove', move); r.original.addEventListener('pointerup', up); r.other.addEventListener('pointerup', wrong);
  r.pointer.press(100, 100); move.mockClear();
  r.hit(r.other); r.pointer.move(220, 100); r.hit(null); r.pointer.move(400, 100); r.pointer.release(400, 100);
  expect(move).toHaveBeenCalledTimes(2); expect(up).toHaveBeenCalledOnce(); expect(wrong).not.toHaveBeenCalled();
});
it('does not click after a drag returns to its starting surface', () => {
  const r = setup(), click = vi.fn(); r.original.addEventListener('click', click);
  r.pointer.press(100, 100); r.pointer.move(300, 100); r.pointer.move(100, 100); r.pointer.release(100, 100);
  expect(click).not.toHaveBeenCalled();
});
it('keeps a small pinch wobble clickable but cancels tracking loss and two-hand takeover', () => {
  const r = setup(), click = vi.fn(), cancel = vi.fn(); r.original.addEventListener('click', click); r.original.addEventListener('pointercancel', cancel);
  r.pointer.press(100, 100); r.pointer.move(110, 105); r.pointer.release(110, 105); expect(click).toHaveBeenCalledOnce();
  r.pointer.press(100, 100); r.hit(r.other); r.pointer.cancelPress(200, 200); expect(cancel).toHaveBeenCalledOnce();
  r.hit(r.original); r.pointer.press(100, 100); r.pointer.reset(); expect(cancel).toHaveBeenCalledTimes(2); expect(click).toHaveBeenCalledOnce();
});
