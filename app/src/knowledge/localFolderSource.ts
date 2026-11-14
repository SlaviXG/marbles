import { parseMarkdown } from "./parseMarkdown";
import type { Note } from "../core/types";

// The narrow KnowledgeSource contract the rest of the app consumes: a one-shot
// load plus a change subscription. The Node server's ObsidianVaultSource already
// implements this shape; LocalFolderSource is its browser twin, so swapping the
// backend leaves the store/graph untouched.
export interface KnowledgeSource {
  loadAll(): Promise<Note[]>;
  watch(handlers: { onUpsert: (n: Note) => void; onRemove: (id: string) => void }): () => void;
}

// Browser-side KnowledgeSource: reads a local folder the user grants through the
// File System Access API. No native daemon, no upload, the files stay in place.
// This is the linchpin that lets the consumer path drop the Node server.
//
// The FS Access API has no file-watch events, so watch() is a poll re-scan that
// diffs by path -> lastModified. Cheap-but-real on purpose: run it on a vault and
// see where it bends (parse cost, poll cost) before reaching for a worker.
export class LocalFolderSource implements KnowledgeSource {
  private seen = new Map<string, number>(); // note id (posix rel path) -> mtime

  private constructor(private readonly dir: FileSystemDirectoryHandle) {}

  // Prompts the OS folder picker. Throws AbortError if the user cancels.
  static async pick(): Promise<LocalFolderSource> {
    const dir = await window.showDirectoryPicker({ mode: "read" });
    return new LocalFolderSource(dir);
  }

  async loadAll(): Promise<Note[]> {
    const notes: Note[] = [];
    for await (const { path, handle } of walk(this.dir)) {
      const note = await this.read(path, handle);
      this.seen.set(note.id, note.mtime);
      notes.push(note);
    }
    return notes;
  }

  watch(
    { onUpsert, onRemove }: { onUpsert: (n: Note) => void; onRemove: (id: string) => void },
    intervalMs = 2000,
  ): () => void {
    let running = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      if (running) return; // skip if a slow scan overruns the interval
      running = true;
      try {
        const present = new Set<string>();
        for await (const { path, handle } of walk(this.dir)) {
          present.add(path);
          const file = await handle.getFile();
          if (this.seen.get(path) !== file.lastModified) {
            const note = await this.read(path, handle, file);
            this.seen.set(path, note.mtime);
            onUpsert(note);
          }
        }
        for (const id of [...this.seen.keys()]) {
          if (!present.has(id)) {
            this.seen.delete(id);
            onRemove(id);
          }
        }
      } catch (e) {
        // Permission revoked or folder removed: stop quietly rather than spamming.
        console.error("[local folder] watch scan failed:", e);
        clearInterval(timer);
      } finally {
        running = false;
      }
    };
    timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }

  // Read + parse a single file into a Note. id/path is the posix folder-relative
  // path (including .md), title is the basename without .md: identical to the
  // server's scheme, so ids line up across backends.
  private async read(path: string, handle: FileSystemFileHandle, file?: File): Promise<Note> {
    const f = file ?? (await handle.getFile());
    const raw = await f.text();
    const title = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
    const parsed = parseMarkdown(raw, path, title);
    return { ...parsed, path, mtime: f.lastModified };
  }
}

// Depth-first walk yielding markdown files as { posix path, file handle }.
// Skips dotfolders (.obsidian, .trash, .git) exactly like the server scan.
async function* walk(
  dir: FileSystemDirectoryHandle,
  prefix = "",
): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of dir.values()) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      yield* walk(entry, path);
    } else if (entry.kind === "file" && entry.name.endsWith(".md")) {
      yield { path, handle: entry };
    }
  }
}
