// Repository: hides the in-memory note store behind a small interface. Swap
// for a persistent store later without touching the rest of the app.
export class NoteRepository {
  #notes = new Map();

  upsert(note) {
    this.#notes.set(note.id, note);
  }

  remove(id) {
    this.#notes.delete(id);
  }

  get(id) {
    return this.#notes.get(id);
  }

  all() {
    return [...this.#notes.values()];
  }

  get size() {
    return this.#notes.size;
  }
}
