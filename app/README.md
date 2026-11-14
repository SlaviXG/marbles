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

## Voice tasks

Set `OPENAI_API_KEY` alongside `OBSIDIAN_VAULT_DIR` in the repository-root
`.env`, then restart `npm run dev`. Use Node.js 20+ and open
`http://localhost:5173` in a browser with AudioWorklet support. Click the floating
marble once to enable the microphone, stay quiet briefly for calibration, then
describe a task. Click it again or use **Turn mic off** to stop.

The marble floats and glows with microphone energy. Live speech and replies
appear as a conversation at the bottom left, with at most three recent bubbles.
Finished messages fade after 20 seconds; hovering or focusing the conversation
pauses expiry. Live transcription and pending handoffs stay visible. Completion
messages include the agent reply and a link to full task details.

The graph reserves green nodes for key deliverables: Markdown, text documents,
Word/PDF files, spreadsheets, slides, and images. Up to 18 recent files connect
directly to their producing agents. Task history and other files stay accessible
from the agent/task panels; dependency and build directories are omitted.

The marble floats and glows with microphone energy. An adaptive local sound
trigger learns ambient noise, requires about 140 ms of sound above that floor,
and uses a lower release threshold to avoid cutting quiet syllables. It keeps
750 ms of pre-roll, commits after 700 ms of quiet, and bounds continuous turns
at 15 seconds. This is energy detection, so sustained non-speech sounds can
also trigger it. A closer microphone helps in noisy rooms.

OpenAI connects only after the first trigger. Initial speech is buffered and
sent in paced chunks while the connection starts; recording stops with a clear
error if a slow connection exceeds the bounded backlog. Mono 24 kHz PCM goes
through the server WebSocket relay to hosted `gpt-live-transcribe`. The permanent
API key stays in Node. Audio is sent to OpenAI and billed to the configured key;
the app does not persist audio.

As soon as final transcripts arrive after a speech pause, the app sends
the complete request to `POST /api/voice/tasks`. OpenAI `gpt-4.1-mini` extracts
the problem, objective, constraints, and success criteria as structured JSON.
Greetings/background speech launch nothing. Unclear requests ask a question;
the next spoken answer includes the original request as clarification context.
A clear task becomes a prompt containing both the original wording and the
structured interpretation.

The existing TaskService chooses an installed, supported, idle Codex or Claude
CLI. Desktop-only agents and unsupported launchers are excluded. Reservations
prevent concurrent voice/manual requests from assigning the same agent. Busy
agents leave the request available for **Retry task**; retry IDs prevent repeated
HTTP requests from launching a task twice. **View task** opens the canvas task
with the transcript, understood goal, exact agent prompt, logs, and artifacts.
Tasks run in the existing fresh per-task folders under `MARBLES_WORKSPACE_DIR`
(default `~/marbles-workspace`), using the CLI's existing login. Mention an
existing project's path if that is the intended target. In-memory task history,
idle tracking, and retry IDs reset when the server restarts; idle means no active
Marbles-managed task, not every unrelated CLI session on the machine.

The relay accepts one voice session from local app origins on ports 5173/5174.
The server binds to loopback and limits payloads, backlogs, and session duration.
Before sharing this server, add authentication and explicit origin configuration.
Keep the frontend on port 5173. The key, audio, and local configuration are never
committed; transcripts and generated prompts remain in the server task history.

API references: [live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Next

Richer parsing (remark AST, frontmatter), search/focus, graph layout polish.
