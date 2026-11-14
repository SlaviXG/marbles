import { describe, it, expect } from "vitest";
import { getDetail } from "../core/detail";
import { notes } from "./fixtures";

describe("getDetail", () => {
  it("resolves a note id", () => {
    const d = getDetail(notes, "a.md");
    expect(d?.kind).toBe("note");
  });

  it("resolves a section id", () => {
    const d = getDetail(notes, "a.md#s1");
    expect(d).toMatchObject({ kind: "section", section: { heading: "S1" } });
  });

  it("resolves a url and lists its references", () => {
    const d = getDetail(notes, "https://example.com/x");
    expect(d?.kind).toBe("url");
    if (d?.kind === "url") {
      expect(d.refs).toContainEqual({ id: "a.md#s1", label: "A › S1" });
    }
  });

  it("returns null for an unknown id", () => {
    expect(getDetail(notes, "nope")).toBeNull();
  });
});
