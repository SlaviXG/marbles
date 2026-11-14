import { describe, it, expect } from "vitest";
import { RegexMarkdownParser } from "../parsing/MarkdownParser.mjs";

const parser = new RegexMarkdownParser();

describe("RegexMarkdownParser", () => {
  const md = "Intro line\n\n### Section One\n- item a\nsee https://example.com/x and [[Other]]\n";
  const note = parser.parse(md, "a.md", "A");

  it("keeps the title and id", () => {
    expect(note).toMatchObject({ id: "a.md", title: "A" });
  });

  it("splits sections by heading", () => {
    expect(note.sections.map((s) => s.heading)).toContain("Section One");
  });

  it("captures items, urls, and wikilinks", () => {
    const sec = note.sections.find((s) => s.heading === "Section One");
    expect(sec.items).toContain("item a");
    expect(sec.urls).toContain("https://example.com/x");
    expect(sec.links).toContain("Other");
  });
});
