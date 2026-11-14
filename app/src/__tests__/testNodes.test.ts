import { describe, it, expect } from "vitest";
import { useVault } from "../state/store";
import { testNotes, isTestId, SHOW_TEST_NODES } from "../core/testNodes";
import { buildGraph } from "../core/graph";
import { getDetail } from "../core/detail";
import { noteA } from "./fixtures";

describe.runIf(SHOW_TEST_NODES)("hardcoded test nodes", () => {
  it("are four clearly marked notes", () => {
    expect(testNotes).toHaveLength(4);
    for (const n of testNotes) {
      expect(isTestId(n.id)).toBe(true);
      expect(n.title.startsWith("[TEST]")).toBe(true);
    }
  });

  it("survive a vault snapshot alongside the real notes", () => {
    useVault.getState().setSnapshot([noteA]);
    const ids = Object.keys(useVault.getState().notes);
    expect(ids).toContain("a.md");
    expect(ids.filter(isTestId)).toHaveLength(4);
  });

  it("link to each other and resolve to details", () => {
    const notes = Object.fromEntries(testNotes.map((n) => [n.id, n]));
    const { links } = buildGraph(notes);
    expect(links.some((l) => l.source === "__test__/alpha.md" && l.target === "__test__/beta.md")).toBe(true);
    expect(getDetail(notes, "https://example.com/marbles-test")).toMatchObject({ kind: "url", refs: [{}, {}] });
  });
});
