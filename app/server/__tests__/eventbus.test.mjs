import { describe, it, expect } from "vitest";
import { EventBus } from "../events/EventBus.mjs";

describe("EventBus", () => {
  it("notifies subscribers and stops after unsubscribe", () => {
    const bus = new EventBus();
    const seen = [];
    const off = bus.on("x", (p) => seen.push(p));

    bus.emit("x", 1);
    bus.emit("x", 2);
    off();
    bus.emit("x", 3); // ignored

    expect(seen).toEqual([1, 2]);
  });
});
