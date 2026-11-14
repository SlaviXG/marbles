import { describe, expect, it } from "vitest";
import { CursorDriver, type HandState, type PointerSink } from "../cursorDriver";
import type { Action } from "../actions";

// The driver owns no clock and no DOM, so a whole gesture can be scripted: set
// the hand state, step frames at a fake 60fps, and read what reached the sink.
const FRAME = 1000 / 60;

function rig() {
  const calls: string[] = [];
  const at: Record<string, { x: number; y: number }> = {};
  const log = (name: string) => (x = 0, y = 0) => {
    calls.push(name);
    at[name] = { x, y };
  };
  const sink: PointerSink = {
    move: log("move"),
    press: log("press"),
    release: log("release"),
    cancelPress: log("cancelPress"),
    reset: log("reset"),
  };
  const actions: Action[] = [];
  const primary: HandState = { x: 400, y: 300, present: true, pinching: false, lastSeen: 0 };
  const secondary: HandState = { x: 0, y: 0, present: false, pinching: false, lastSeen: 0 };
  let now = 0;
  const driver = new CursorDriver(
    { sink, emit: (a) => actions.push(a), magnet: () => null },
    now,
    primary.x,
    primary.y,
  );
  let handMode = true;
  // Step n frames; hands flagged present are kept fresh, as the tracker would.
  const run = (n: number) => {
    let f = driver.step(now, primary, secondary, handMode);
    for (let i = 0; i < n; i++) {
      now += FRAME;
      if (primary.present) primary.lastSeen = now;
      if (secondary.present) secondary.lastSeen = now;
      f = driver.step(now, primary, secondary, handMode);
    }
    return f;
  };
  const count = (name: string) => calls.filter((c) => c === name).length;
  return {
    primary,
    secondary,
    actions,
    at,
    run,
    count,
    setHandMode: (on: boolean) => (handMode = on),
    lose: () => (primary.present = false),
  };
}

describe("CursorDriver", () => {
  it("turns a stationary pinch into one press and one release at the same point", () => {
    const r = rig();
    r.run(30);
    r.primary.pinching = true;
    r.run(10);
    r.primary.pinching = false;
    r.run(10);
    expect(r.count("press")).toBe(1);
    expect(r.count("release")).toBe(1);
    expect(r.at.release.x).toBeCloseTo(r.at.press.x, 3);
    expect(r.at.release.y).toBeCloseTo(r.at.press.y, 3);
  });

  it("anchors the press against the pinch dip, so the dot does not jump", () => {
    const r = rig();
    r.run(30);
    // The index tip dips as the pinch closes: tracking moves, the user did not.
    r.primary.y += 20;
    r.run(3);
    r.primary.pinching = true;
    r.run(1);
    expect(r.at.press.y).toBeCloseTo(300, 0);
  });

  it("follows the hand and fades in", () => {
    const r = rig();
    r.primary.x = 700;
    const f = r.run(60);
    expect(f.x).toBeCloseTo(700, 0);
    expect(f.opacity).toBeCloseTo(1, 1);
    expect(f.active).toBe(true);
  });

  it("hands a two-handed pinch over to zoom and pan, and latches the press off", () => {
    const r = rig();
    r.run(30);
    r.primary.pinching = true;
    r.run(5);
    Object.assign(r.secondary, { x: 600, y: 300, present: true, pinching: true });
    r.run(2);
    expect(r.count("cancelPress")).toBe(1);

    r.secondary.x = 700; // hands apart: zoom in, and the midpoint moves: pan
    r.run(2);
    const zoom = r.actions.find((a) => a.type === "zoom");
    expect(zoom && zoom.type === "zoom" && zoom.delta).toBeLessThan(0);
    expect(r.actions.some((a) => a.type === "pan")).toBe(true);

    // Second hand lets go while the first stays pinched: that must not start a
    // drag, and its eventual release must not click.
    r.secondary.pinching = false;
    r.run(5);
    expect(r.count("press")).toBe(1);
  });

  it("resets the sink when the hand leaves", () => {
    const r = rig();
    r.run(30);
    r.lose();
    r.run(2);
    expect(r.count("reset")).toBe(1);
  });

  it("sends nothing while the mouse owns the cursor", () => {
    const r = rig();
    r.setHandMode(false);
    r.primary.pinching = true;
    const f = r.run(30);
    expect(r.count("move") + r.count("press")).toBe(0);
    expect(f.active).toBe(false);
  });
});
