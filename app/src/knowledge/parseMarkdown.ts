import { RegexMarkdownParser } from "../../server/parsing/MarkdownParser.mjs";
import type { Note } from "../core/types";

// Reuse the EXACT parser the Node server uses (pure string work, zero Node
// deps). Browser-read notes must get byte-identical section ids and [[wikilinks]]
// as the server would produce, because the graph links notes by those ids: any
// divergence would silently drop edges. So we share the one parser rather than
// re-implement it here. (Pure domain logic that currently lives under server/;
// a later move to a shared core/ home is noted in the vault's "Design Decisions".)
const parser = new RegexMarkdownParser();

export function parseMarkdown(
  raw: string,
  id: string,
  title: string,
): Pick<Note, "id" | "title" | "sections"> {
  return parser.parse(raw, id, title);
}
