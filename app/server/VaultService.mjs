// Facade, backend-agnostic. Talks only to a KnowledgeSource (Strategy), keeps
// the repository in sync with it, and republishes changes on the bus. It does
// not know whether notes come from Obsidian, an API, or a database.
export class VaultService {
  constructor({ source, repository, bus }) {
    this.source = source;
    this.repo = repository;
    this.bus = bus;
    this.stop = () => {};
  }

  async start() {
    for (const note of await this.source.loadAll()) this.repo.upsert(note);
    this.stop = this.source.watch({
      onUpsert: (note) => {
        this.repo.upsert(note);
        this.bus.emit("update", note);
        console.log(`updated: ${note.id}`);
      },
      onRemove: (id) => {
        this.repo.remove(id);
        this.bus.emit("remove", { id });
        console.log(`removed: ${id}`);
      },
    });
    return this;
  }

  snapshot() {
    return { notes: this.repo.all() };
  }

  // Subscribe to change events as a normalized stream of { type, ... }.
  onChange(handler) {
    const offU = this.bus.on("update", (note) => handler({ type: "update", note }));
    const offR = this.bus.on("remove", ({ id }) => handler({ type: "remove", id }));
    return () => {
      offU();
      offR();
    };
  }
}
