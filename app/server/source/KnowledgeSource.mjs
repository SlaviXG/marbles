// Strategy port for the knowledge base.
//
// VaultService talks only to this interface, so the backing store (Obsidian
// markdown today; Notion, SQLite, a remote API later) can be swapped at the
// composition root without touching the rest of the app.
//
// A KnowledgeSource implements:
//
//   loadAll(): Promise<Note[]>
//     Resolve the full current set of notes (initial snapshot).
//
//   watch({ onUpsert, onRemove }): () => void
//     Begin streaming changes. Call onUpsert(note) on add/change and
//     onRemove(id) on delete. Return a stop() function.
//
// Implementations produce the shared Note domain model regardless of backend.
export {};
