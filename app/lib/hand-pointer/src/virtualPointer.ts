// Makes the camera cursor act in place of the mouse by synthesizing DOM pointer
// events at a screen position. On each move we find the element under the point
// and dispatch bubbling pointerover/pointerout (with relatedTarget) on target
// change plus a pointermove; React derives onPointerEnter/Leave/Move from these,
// so existing handlers respond unchanged (graph hover-to-open, immersive
// hover-out, buttons, links). The cursor element is pointer-events:none, so
// elementFromPoint sees through it to what is really underneath.
//
// Press/release give it the full set: a pinch presses (pointerdown), releasing
// the pinch lifts (pointerup) and clicks; moving while pressed drags. Driven by
// the pinch gesture (thumb + index) in HandCursor.
export class VirtualPointer {
  private last: Element | null = null;
  private pressed = false;
  private downTarget: Element | null = null;
  private downX = 0;
  private downY = 0;
  private travelled = 0;

  private event(type: string, x: number, y: number, related: Element | null): PointerEvent {
    return new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: this.pressed ? 1 : 0,
      pointerId: 0x4d42,
      pointerType: "mouse",
      isPrimary: true,
      relatedTarget: related,
      view: window,
    });
  }

  move(x: number, y: number) {
    if (this.pressed) {
      // Synthetic events do not get native pointer capture. Keep carrying the
      // original surface even when the dot crosses a window, iframe or edge.
      this.travelled = Math.max(this.travelled, Math.hypot(x - this.downX, y - this.downY));
      (this.downTarget?.isConnected ? this.downTarget : window).dispatchEvent(this.event("pointermove", x, y, null));
      return;
    }
    const target = document.elementFromPoint(x, y);
    if (target !== this.last) {
      if (this.last) this.last.dispatchEvent(this.event("pointerout", x, y, target));
      if (target) target.dispatchEvent(this.event("pointerover", x, y, this.last));
      this.last = target;
    }
    if (target) target.dispatchEvent(this.event("pointermove", x, y, null));
  }

  press(x: number, y: number) {
    if (this.pressed) return;
    this.move(x, y); // make sure we are over the right element first
    const target = this.last;
    this.pressed = true;
    this.downTarget = target;
    this.downX = x; this.downY = y; this.travelled = 0;
    target?.dispatchEvent(this.event("pointerdown", x, y, null));
  }

  release(x: number, y: number) {
    if (!this.pressed) return;
    const target = document.elementFromPoint(x, y);
    this.pressed = false;
    const down = this.downTarget;
    (down?.isConnected ? down : window).dispatchEvent(this.event("pointerup", x, y, null));
    // A click fires only if release lands on the element the press began on
    // (same as a real mouse), so a drag that moves off does not click.
    if (target && target === down && this.travelled <= 30 && Math.hypot(x - this.downX, y - this.downY) <= 30) {
      target.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window }),
      );
    }
    this.downTarget = null;
    this.move(x, y);
  }

  // Abandon a press WITHOUT touching hover state, for when a gesture is taken
  // over by another one (a second hand joining to zoom). reset() is wrong here:
  // it emits pointerout, which React reports as pointerleave, and a hover-driven
  // surface reads that as "the pointer left, dismiss me" (the open note closed
  // the instant a two-handed zoom began). Nothing has left anything; the press
  // simply stopped being a press, which is what pointercancel means.
  cancelPress(x: number, y: number) {
    if (!this.pressed) return;
    const target = this.downTarget;
    this.pressed = false;
    this.downTarget = null;
    (target?.isConnected ? target : window).dispatchEvent(this.event("pointercancel", x, y, null));
  }

  // Hand left the frame (or tracking stopped): lift and release any hover.
  reset(x = 0, y = 0) {
    if (this.pressed) this.cancelPress(x, y);
    if (this.last) this.last.dispatchEvent(this.event("pointerout", x, y, null));
    this.last = null;
  }
}
