import { loadConfig } from "./config.mjs";
import { EventBus } from "./events/EventBus.mjs";
import { RegexMarkdownParser } from "./parsing/MarkdownParser.mjs";
import { NoteRepository } from "./storage/NoteRepository.mjs";
import { ChokidarWatcher } from "./watch/FileWatcher.mjs";
import { ObsidianVaultSource } from "./source/ObsidianVaultSource.mjs";
import { VaultService } from "./VaultService.mjs";
import { createApp } from "./transport/createApp.mjs";

// Composition root: build the object graph and wire the layers together.
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  // Swap this one line to change knowledge backends; the rest is agnostic.
  const source = new ObsidianVaultSource({
    vaultDir: config.vaultDir,
    parser: new RegexMarkdownParser(),
    watcher: new ChokidarWatcher(config.vaultDir),
  });

  const service = await new VaultService({
    source,
    repository: new NoteRepository(),
    bus: new EventBus(),
  }).start();

  console.log(`Parsed ${service.snapshot().notes.length} note(s) from ${config.vaultDir}`);

  createApp(service).listen(config.port, () =>
    console.log(`vault-viz server: http://localhost:${config.port}`),
  );
}

main();
