// Strategy: anything with `parse(raw, id, title) -> Note` is a MarkdownParser.
// RegexMarkdownParser is the current strategy; a RemarkParser (full AST) could
// replace it without touching callers.

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const URL_RE = /(https?:\/\/[^\s)>\]]+)/g;

function stripFrontmatter(text) {
  if (!text.startsWith("---")) return text;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

function finalize(sec) {
  const text = sec.lines.join("\n").trim();
  sec.content = text;
  sec.urls = [...new Set([...text.matchAll(URL_RE)].map((m) => m[1]))];
  sec.links = [...new Set([...text.matchAll(WIKILINK)].map((m) => m[1].trim()))];
  delete sec.lines;
  return sec;
}

export class RegexMarkdownParser {
  // Parse markdown into a note model: sections keyed by heading, each carrying
  // its list items, external URLs, and [[wikilinks]].
  parse(raw, id, title) {
    const body = stripFrontmatter(raw);
    const lines = body.split(/\r?\n/);
    const sections = [];
    // Position-based ids (not heading-derived), so renaming a heading keeps the
    // section's id stable. Downstream, that makes a rename a label-only update
    // rather than a remove + add (no graph restructure).
    let index = 0;
    let cur = { id: `${id}#${index++}`, heading: null, level: 0, lines: [], items: [] };

    const flush = () => {
      if (cur.heading || cur.lines.some((l) => l.trim() !== "") || cur.items.length) {
        sections.push(finalize(cur));
      }
    };

    for (const line of lines) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flush();
        cur = { id: `${id}#${index++}`, heading: h[2].trim(), level: h[1].length, lines: [], items: [] };
        continue;
      }
      cur.lines.push(line);
      const li = line.match(/^\s*[-*+]\s+(.*)$/);
      if (li) cur.items.push(li[1].trim());
    }
    flush();

    return { id, title, sections };
  }
}
