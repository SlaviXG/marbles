import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianVaultSource } from "../source/ObsidianVaultSource.mjs";
import { RegexMarkdownParser } from "../parsing/MarkdownParser.mjs";

let dir;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  fs.writeFileSync(path.join(dir, "Note.md"), "### S\n- a\nhttps://x.com\n");
  fs.mkdirSync(path.join(dir, ".obsidian"));
  fs.writeFileSync(path.join(dir, ".obsidian", "skip.md"), "ignored");
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("ObsidianVaultSource", () => {
  it("loads markdown notes and skips dotfolders", async () => {
    const source = new ObsidianVaultSource({ vaultDir: dir, parser: new RegexMarkdownParser() });
    const notes = await source.loadAll();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: "Note.md", title: "Note" });
  });
});
