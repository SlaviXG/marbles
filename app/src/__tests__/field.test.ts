import { describe, expect, it } from "vitest";
import {
  FIELD_PAD,
  ZOOM_FIT,
  ZOOM_MOST_IN,
  ZOOM_MOST_OUT,
  fieldOf,
  minZoom,
} from "../core/field";

describe("fieldOf", () => {
  it("is the padded box around the positioned nodes", () => {
    const f = fieldOf([{ x: -50, y: 10 }, { x: 200, y: -30 }, { x: 0, y: 90 }]);
    expect(f).toEqual({
      minX: -50 - FIELD_PAD,
      minY: -30 - FIELD_PAD,
      maxX: 200 + FIELD_PAD,
      maxY: 90 + FIELD_PAD,
    });
  });

  it("ignores nodes the layout has not placed yet", () => {
    const f = fieldOf([{ x: 10, y: 10 }, {}, { x: NaN, y: 0 }], 0);
    expect(f).toEqual({ minX: 10, minY: 10, maxX: 10, maxY: 10 });
  });

  it("falls back to a box at the origin with no nodes", () => {
    expect(fieldOf([], 100)).toEqual({ minX: -100, minY: -100, maxX: 100, maxY: 100 });
  });
});

describe("minZoom", () => {
  it("fits the field into the tighter dimension of the viewport", () => {
    // 2000 x 1000 field in a 1200 x 800 view: width is the tighter fit.
    const f = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
    expect(minZoom(f, 1200, 800)).toBeCloseTo((1200 / 2000) * ZOOM_FIT, 6);
  });

  it("never forces a small field to zoom in", () => {
    const f = { minX: 0, minY: 0, maxX: 300, maxY: 300 };
    expect(minZoom(f, 1200, 800)).toBe(ZOOM_MOST_IN);
  });

  it("never lets a huge field shrink to nothing", () => {
    const f = { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 };
    expect(minZoom(f, 1200, 800)).toBe(ZOOM_MOST_OUT);
  });

  it("is safe before the view has a size", () => {
    expect(minZoom({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 0)).toBe(ZOOM_MOST_IN);
  });
});
