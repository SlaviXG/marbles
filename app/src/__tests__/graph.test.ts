import { describe, it, expect } from "vitest";
import { buildGraph } from "../core/graph";
import { notes } from "./fixtures";

describe("buildGraph", () => {
  const { nodes, links } = buildGraph(notes);

  it("creates a node per note, section, and url", () => {
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toContain("a.md");
    expect(ids).toContain("b.md");
    expect(ids).toContain("a.md#s1");
    expect(ids).toContain("https://example.com/x");
  });

  it("links note -> section and section -> url", () => {
    expect(links).toContainEqual({ source: "a.md", target: "a.md#s1" });
    expect(links).toContainEqual({ source: "a.md#s1", target: "https://example.com/x" });
  });

  it("resolves a [[wikilink]] to the target note", () => {
    expect(links).toContainEqual({ source: "a.md", target: "b.md" });
  });
});
