import { describe, expect, it } from "vitest";
import { dispatchAction, registerActionHandler, PRIORITY, type Action } from "../actions";

const zoom = (delta = -10): Action => ({ type: "zoom", delta, x: 0, y: 0, pinch: true });

describe("action chain", () => {
  it("returns false when nothing is registered", () => {
    expect(dispatchAction(zoom())).toBe(false);
  });

  it("stops at the first handler that claims the action", () => {
    const seen: string[] = [];
    const un1 = registerActionHandler(() => {
      seen.push("world");
      return true;
    }, PRIORITY.world);
    const un2 = registerActionHandler(() => {
      seen.push("overlay");
      return true;
    }, PRIORITY.overlay);

    expect(dispatchAction(zoom())).toBe(true);
    // Higher priority runs first and the lower one never sees it: this is what
    // keeps an open note from also zooming the graph behind it.
    expect(seen).toEqual(["overlay"]);
    un1();
    un2();
  });

  it("falls through to the next handler when one declines", () => {
    const seen: string[] = [];
    const un1 = registerActionHandler(() => {
      seen.push("world");
      return true;
    }, PRIORITY.world);
    const un2 = registerActionHandler(() => {
      seen.push("overlay");
      return false; // e.g. an overlay that is mounted but not open
    }, PRIORITY.overlay);

    expect(dispatchAction(zoom())).toBe(true);
    expect(seen).toEqual(["overlay", "world"]);
    un1();
    un2();
  });

  it("unregisters cleanly, restoring the surface behind", () => {
    const un1 = registerActionHandler(() => true, PRIORITY.world);
    const un2 = registerActionHandler(() => true, PRIORITY.overlay);
    un2();
    expect(dispatchAction(zoom())).toBe(true); // world still claims it
    un1();
    expect(dispatchAction(zoom())).toBe(false);
  });

  it("tolerates a handler that unregisters during dispatch", () => {
    // An overlay may close in response to the very action it is handling, which
    // mutates the list mid-walk. Dispatch iterates a copy so this cannot skip.
    const seen: string[] = [];
    const un2 = registerActionHandler(() => {
      seen.push("overlay");
      un2();
      return false;
    }, PRIORITY.overlay);
    const un1 = registerActionHandler(() => {
      seen.push("world");
      return true;
    }, PRIORITY.world);

    expect(dispatchAction(zoom())).toBe(true);
    expect(seen).toEqual(["overlay", "world"]);
    un1();
  });
});
