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
`http://localhost:5173` in a browser with AudioWorklet support. The app requests
microphone permission and loads a local wake model automatically. Say **Hey
Marbles**, then describe your task. The marble returns to wake mode after a task
is assigned or 20 seconds without speech. Use **Turn mic off** to stop; click the
marble to enable it again. Browsers that require an initial audio gesture show
**Enable microphone** once before hands-free listening can begin.

The marble floats and glows with microphone energy. Live speech and replies
appear as a conversation at the bottom left, with at most three recent bubbles.
Finished messages fade after 20 seconds; hovering or focusing the conversation
pauses expiry. Live transcription and pending handoffs stay visible. Completion
messages include the agent reply and a link to full task details.

The graph reserves green nodes for key deliverables: Markdown, text documents,
Word/PDF files, spreadsheets, slides, and images. Up to 18 recent files connect
directly to their producing agents. Task history and other files stay accessible
from the agent/task panels; dependency and build directories are omitted.

Standby wake recognition uses quantized `Xenova/whisper-tiny.en` in a browser
worker via Transformers.js (Apache-2.0 model). A setup script installs the pinned
model and matching ONNX runtime under
`app/public` and serves them from localhost. `npm run dev`, `npm run client`, and
`npm run build` run setup automatically; `npm run setup:wake` can also be run
explicitly. Setup needs network access once, then reuses the verified file sizes.
The browser never downloads wake assets from Hugging Face or a CDN. Generated
model/runtime files are gitignored and copied into production builds. It runs one
inference at a time over overlapping audio
windows, gated by local audio energy, with bounded history. Only a complete
**Hey Marbles** word match opens OpenAI transcription. Word timestamps preserve
the command after the wake phrase while dropping preceding room/playback audio.
This is local ASR-based wake recognition rather than a trained keyword-only
model; latency and accuracy depend on the device, accent, and room noise.
An isolated inference failure retries with a fresh window after a short backoff.
Repeated failures show the actual runtime error. Word alignment runs only after
a possible wake phrase is detected, reducing background inference work.

After wake-up, an adaptive sound trigger commits phrases after 700 ms of quiet
and caps continuous turns at 15 seconds. Mono 24 kHz PCM streams to hosted
`gpt-live-transcribe` through the server. Standby audio stays local; command audio
is sent to OpenAI. Initial command audio is buffered and paced, with a bounded
backlog and visible errors if the connection cannot keep up.

Final replies are read with OpenAI `gpt-4o-mini-tts`, Coral voice, through
`POST /api/voice/speech`. **AI voice on/muted** toggles automatic playback;
**Stop reply** interrupts it; **Read aloud** replays a message. Text stays visible
if audio fails or the browser blocks playback. Code blocks and URLs are simplified
for speech and long replies are shortened. Up to three replies queue, with three
clips cached in memory. The voice is AI-generated. Text-to-speech uses the same
server-side key and incurs OpenAI API usage. This Speech API model is supported
until its announced January 6, 2027 shutdown; migrate this endpoint before then.

While a reply plays, microphone audio is held out of cloud transcription. The
local wake detector remains available, so **Hey Marbles** interrupts playback and
opens the next request. Spoken replies replace the literal wake phrase to avoid
self-activation. Synthesis is cancelled on interruption, muting, or unmounting;
audio object URLs and microphone resources are released. The Vite development
server exposes the speech handler directly as well, so updating speech playback
does not require restarting an active agent runner. Neither route exposes the key.

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
