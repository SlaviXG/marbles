import fs from "node:fs";
import path from "node:path";

// KnowledgeSource strategy: an Obsidian vault of markdown files on disk.
// Owns every Obsidian-specific concern (filesystem layout, file reads, markdown
// parsing, dotfolder skipping) and emits the shared Note domain model. Composes
// a FileWatcher (Adapter) for change notifications.
export class ObsidianVaultSource {
  constructor({ vaultDir, parser, watcher }) {
    this.vaultDir = vaultDir;
    this.parser = parser;
    this.watcher = watcher;
  }

  #readNote(rel) {
    const full = path.join(this.vaultDir, rel);
    const raw = fs.readFileSync(full, "utf8");
    const id = rel.replace(/\\/g, "/");
    const note = this.parser.parse(raw, id, path.basename(rel, ".md"));
    note.path = id;
    note.mtime = fs.statSync(full).mtimeMs;
    return note;
  }

  #scan(dir, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue; // skip .obsidian, .trash, etc.
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this.#scan(full, out);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(path.relative(this.vaultDir, full));
    }
  }

  async loadAll() {
    const rels = [];
    this.#scan(this.vaultDir, rels);
    return rels.map((rel) => this.#readNote(rel));
  }

  watch({ onUpsert, onRemove }) {
    this.watcher.start({
      onUpsert: (rel) => {
        try {
          onUpsert(this.#readNote(rel));
        } catch (e) {
          console.error(`parse error for ${rel}: ${e.message}`);
        }
      },
      onRemove: (rel) => onRemove(rel.replace(/\\/g, "/")),
    });
    return () => this.watcher.stop();
  }
}
