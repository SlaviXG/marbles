// The registry owns fresh discovery and broadcasts only meaningful changes.
export class AgentRegistry {
  constructor({ detector, intervalMs = 10_000 } = {}) {
    this.detector = detector;
    this.intervalMs = intervalMs;
    this.agents = [];
    this.listeners = new Set();
    this.inFlight = null;
    this.timer = null;
  }

  snapshot() { return this.agents; }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  refresh() {
    if (this.inFlight) return this.inFlight;
    const run = Promise.resolve().then(() => this.detector()).then((agents) => {
      const previous = new Map(this.agents.map(agent => [agent.id, agent]));
      const next = new Map(agents.map(agent => [agent.id, agent]));
      this.agents = agents;
      for (const [id, agent] of next) {
        const old = previous.get(id);
        if (!old || JSON.stringify(old) !== JSON.stringify(agent)) {
          const event = { type: old ? "changed" : "added", agent };
          for (const listener of this.listeners) listener(event);
        }
      }
      for (const id of previous.keys()) if (!next.has(id)) {
        for (const listener of this.listeners) listener({ type: "removed", id });
      }
      return this.agents;
    });
    this.inFlight = run;
    void run.finally(() => { if (this.inFlight === run) this.inFlight = null; }).catch(() => {});
    return run;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(error => console.error("Agent detection failed:", error));
    }, this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
