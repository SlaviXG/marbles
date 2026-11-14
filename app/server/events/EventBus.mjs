// Observer pattern: a minimal synchronous publish/subscribe bus. Producers
// (the watcher via VaultService) emit; consumers (the SSE transport) subscribe,
// so neither side knows about the other.
export class EventBus {
  #handlers = new Map(); // event -> Set<fn>

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    for (const fn of this.#handlers.get(event) ?? []) fn(payload);
  }
}
