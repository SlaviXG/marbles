import type { Note } from "./types";

// TEST DATA. Four hardcoded dummy notes so the UI has something to show without
// an Obsidian vault or a picked folder. They are NOT real notes: every id starts
// with TEST_PREFIX, every title starts with "[TEST]", and they are merged into
// the store alongside whatever the vault or folder loads.
//
// To turn them off, set SHOW_TEST_NODES to false. To remove them for good,
// delete this file and its two imports (state/store.ts, App.tsx).
export const SHOW_TEST_NODES = true;

export const TEST_PREFIX = "__test__/";

export const isTestId = (id: string) => id.startsWith(TEST_PREFIX);

const NOTE = "Hardcoded test node from app/src/core/testNodes.ts. Not part of any vault.";

function testNote(slug: string, title: string, sections: Omit<Note["sections"][number], "id">[]): Note {
  const id = `${TEST_PREFIX}${slug}.md`;
  return {
    id,
    title: `[TEST] ${title}`,
    path: id,
    mtime: 0,
    sections: sections.map((s, i) => ({ ...s, id: s.heading ? `${id}#${slug}-${i}` : `${id}#intro` })),
  };
}

const TEST_NOTES: Note[] = [
  testNote("alpha", "Alpha", [
    { heading: null, level: 0, content: NOTE, items: [], links: ["[TEST] Beta", "[TEST] Gamma"], urls: [] },
    {
      heading: "What to try",
      level: 2,
      content: "Click this node, then a linked node, to check the detail panel switches.",
      items: ["Click a node to open details", "Click the background to close", "Pinch with the hand cursor to click"],
      links: [],
      urls: [],
    },
  ]),
  testNote("beta", "Beta", [
    { heading: null, level: 0, content: NOTE, items: [], links: ["[TEST] Delta"], urls: [] },
    {
      heading: "Sources",
      level: 2,
      content: "A section with an external link, which renders as a URL node.",
      items: [],
      links: [],
      urls: ["https://example.com/marbles-test"],
    },
  ]),
  testNote("gamma", "Gamma", [
    { heading: null, level: 0, content: NOTE, items: ["List item one", "List item two"], links: ["[TEST] Delta"], urls: [] },
  ]),
  testNote("delta", "Delta", [
    { heading: null, level: 0, content: NOTE, items: [], links: ["[TEST] Alpha"], urls: [] },
    {
      heading: "Shared link",
      level: 2,
      content: "Points at the same URL as Beta, so the URL node shows two references.",
      items: [],
      links: [],
      urls: ["https://example.com/marbles-test"],
    },
  ]),
];

// What the store starts with, and merges into every snapshot.
export const testNotes: Note[] = SHOW_TEST_NODES ? TEST_NOTES : [];
