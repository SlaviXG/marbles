import type { Note, Section } from "./types";

export type Detail =
  | { kind: "note"; note: Note }
  | { kind: "section"; note: Note; section: Section }
  | { kind: "url"; url: string; refs: { id: string; label: string }[] };

export function hostname(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

// A resolver turns a node id into renderable Detail, or null if it doesn't
// handle that id. Node ids are: a note path, a section id (`<note>#<slug>`),
// or a raw URL.
type Resolver = (notes: Record<string, Note>, id: string) => Detail | null;

const resolveNote: Resolver = (notes, id) => (notes[id] ? { kind: "note", note: notes[id] } : null);

const resolveUrl: Resolver = (notes, id) => {
  if (!/^https?:/.test(id)) return null;
  const refs: { id: string; label: string }[] = [];
  for (const n of Object.values(notes)) {
    for (const s of n.sections) {
      if (s.urls.includes(id)) {
        refs.push({ id: s.heading ? s.id : n.id, label: s.heading ? `${n.title} › ${s.heading}` : n.title });
      }
    }
  }
  return { kind: "url", url: id, refs };
};

const resolveSection: Resolver = (notes, id) => {
  const hash = id.indexOf("#");
  if (hash <= 0) return null;
  const note = notes[id.slice(0, hash)];
  const section = note?.sections.find((s) => s.id === id);
  return note && section ? { kind: "section", note, section } : null;
};

// Strategy / chain of responsibility: try each resolver in order, first match
// wins. New node kinds plug in by adding a resolver here.
const resolvers: Resolver[] = [resolveNote, resolveUrl, resolveSection];

export function getDetail(notes: Record<string, Note>, id: string): Detail | null {
  for (const resolve of resolvers) {
    const detail = resolve(notes, id);
    if (detail) return detail;
  }
  return null;
}
