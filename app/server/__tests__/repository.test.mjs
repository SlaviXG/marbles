import { describe, it, expect } from "vitest";
import { NoteRepository } from "../storage/NoteRepository.mjs";

describe("NoteRepository", () => {
  it("upserts, reads, lists, and removes", () => {
    const repo = new NoteRepository();
    repo.upsert({ id: "a", title: "A" });
    expect(repo.get("a").title).toBe("A");
    expect(repo.size).toBe(1);

    repo.upsert({ id: "a", title: "A2" }); // upsert replaces
    expect(repo.get("a").title).toBe("A2");
    expect(repo.all()).toHaveLength(1);

    repo.remove("a");
    expect(repo.size).toBe(0);
  });
});
