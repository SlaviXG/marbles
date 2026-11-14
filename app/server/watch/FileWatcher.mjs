import chokidar from "chokidar";

// Adapter: wraps chokidar behind a minimal FileWatcher interface
//   start({ onUpsert, onRemove }) / stop()
// so the rest of the app never depends on chokidar directly.
export class ChokidarWatcher {
  #watcher = null;

  constructor(vaultDir) {
    this.vaultDir = vaultDir;
  }

  start({ onUpsert, onRemove }) {
    this.#watcher = chokidar.watch("**/*.md", {
      cwd: this.vaultDir,
      ignoreInitial: true,
      ignored: /(^|[\\/])\../,
    });
    this.#watcher.on("add", onUpsert).on("change", onUpsert).on("unlink", onRemove);
    return this;
  }

  stop() {
    return this.#watcher?.close();
  }
}
