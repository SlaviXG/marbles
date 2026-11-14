import { describe, it, expect, beforeEach } from "vitest";
import { useVault } from "../state/store";
import { getDetail } from "../core/detail";
import { noteA, noteB } from "./fixtures";

describe("selection (switching while the panel is open)", () => {
  beforeEach(() => {
    useVault.getState().setSnapshot([noteA, noteB]);
    useVault.getState().clear();
  });

  it("switches the selected node to a different node", () => {
    const { select } = useVault.getState();
    select("a.md");
    expect(useVault.getState().selectedId).toBe("a.md");

    // Clicking a second node while the first is open must switch, not no-op.
    select("b.md");
    expect(useVault.getState().selectedId).toBe("b.md");

    const detail = getDetail(useVault.getState().notes, useVault.getState().selectedId!);
    expect(detail).toMatchObject({ kind: "note", note: { title: "B" } });
  });

  it("clears selection on background click", () => {
    const { select, clear } = useVault.getState();
    select("a.md");
    clear();
    expect(useVault.getState().selectedId).toBeNull();
  });
});
