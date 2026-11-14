import type { Note } from "../core/types";

export const noteA: Note = {
  id: "a.md",
  title: "A",
  path: "a.md",
  mtime: 1,
  sections: [
    {
      id: "a.md#s1",
      heading: "S1",
      level: 3,
      content: "see B and a link",
      items: ["item one"],
      links: ["B"],
      urls: ["https://example.com/x"],
    },
  ],
};

export const noteB: Note = {
  id: "b.md",
  title: "B",
  path: "b.md",
  mtime: 1,
  sections: [
    { id: "b.md#intro", heading: null, level: 0, content: "", items: [], links: [], urls: [] },
  ],
};

export const notes: Record<string, Note> = { "a.md": noteA, "b.md": noteB };
