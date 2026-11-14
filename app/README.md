# Marbles

Live visualization of the Obsidian vault. Edit a note in Obsidian, the UI
updates automatically.

## How it works

```
edit note in Obsidian
  -> ChokidarWatcher 'change'
  -> VaultService re-parses -> EventBus emit
  -> SSE push -> Zustand store update
  -> only subscribed component(s) re-render
```

## Server (layered)

The server reads `OBSIDIAN_VAULT_DIR` (repo-root `.env`), parses markdown, and
serves a snapshot plus an SSE stream on `:5174`. Responsibilities are split so
each part is swappable and testable:

| Module | Pattern | Role |
| --- | --- | --- |
| `source/KnowledgeSource` | Strategy (port) | backend interface: `loadAll()` + `watch()` |
| `source/ObsidianVaultSource` | Strategy (impl) | Obsidian markdown on disk; owns fs + parsing |
| `parsing/MarkdownParser` | Strategy | markdown -> note model (regex now, remark later) |
| `storage/NoteRepository` | Repository | in-memory note store behind an interface |
| `watch/FileWatcher` | Adapter | wraps chokidar |
| `events/EventBus` | Observer | decouples "changed" from "push over SSE" |
| `VaultService` | Facade | backend-agnostic; syncs source -> repo -> bus |
| `transport/createApp` | - | Express routes + SSE |
| `index.mjs` | - | composition root (swap the source here) |

To use a different knowledge base (Notion, SQLite, an API), implement
`KnowledgeSource` and swap the one line in `index.mjs`. Nothing else changes.

## Client

Vite + React. `useVaultStream` feeds SSE into a Zustand store. A force-directed
graph (notes -> sections -> URLs, plus `[[wikilinks]]`) with manual hit-testing.
Click a node to open a detail panel; click the background to close. `detail.ts`
resolves a node id to renderable detail via a small resolver chain.

## Run

Requires `OBSIDIAN_VAULT_DIR` set in the repo-root `.env`.

```sh
cd app
npm install
npm run dev    # server :5174 + client :5173
npm test       # vitest (client + server units)
```

Open http://localhost:5173. The client proxies `/api` to the server on `:5174`.

## Live voice transcription

Set `OPENAI_API_KEY` in the repository-root `.env`, alongside
`OBSIDIAN_VAULT_DIR`, then restart `npm run dev`. Use Node.js 20+ and open
`http://localhost:5173` in a recent Chrome, Edge, Firefox, or Safari with
AudioWorklet support. Allow microphone access, then use **Start microphone**
in the Voice panel. **Stop microphone** releases the mic immediately and waits
for the final words. Copy or clear the resulting transcript after stopping.

Voice uses OpenAI's hosted `gpt-live-transcribe` model through a server-side
WebSocket relay. Audio is sent to OpenAI while recording, and API usage is
billed to the configured key. The browser captures mono 24 kHz PCM with an
AudioWorklet. Local energy detection keeps 250 ms of pre-roll, commits turns
after 700 ms of silence, and caps continuous turns at 15 seconds. Live deltas
appear before each final transcript; commit IDs preserve phrase order when
completion events arrive out of order. Quiet speech may need a closer mic.

The permanent API key stays in the Node process, never in browser code or
client messages. Audio and transcripts are not persisted by this app. The relay
accepts one session at a time from local app origins on ports 5173/5174, with
payload, backlog, startup, and session-duration limits. The backend binds to
loopback; add authentication and explicit origin configuration before deploying
it as a shared service. Keep the frontend on port 5173.

This is a transcription preview, with no agent dispatch yet. Transcript text
is available in the panel for future prompt integration.

API references: [live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
and [WebSocket connections](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime).

## Next

Richer parsing (remark AST, frontmatter), search/focus, graph layout polish.
