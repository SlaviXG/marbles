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
Point and pinch (or click) a marble to open its details. Use **Close details**, Escape, or a short press on empty canvas to dismiss. `detail.ts`
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
`.env`, then restart `npm run dev`. Use Node.js 22.13+ and open
`http://localhost:5173` in a browser with AudioWorklet support. The single canvas
shows holographic agent cores with readable names, availability and the latest
task state. There are no navigation tabs or typed task composer.

The single canvas is a restrained holographic space: dark blue surfaces, cyan
agent cores, a quiet projection plane and readable labels. Agent motion follows
real task state: breathing halos while waiting, rotating segmented rings while
working, a short completion pulse and checkmark when finished, and amber warning
glyphs after failure. Reduced motion keeps static glyphs. Positions stay fixed
for hand targeting, and hidden pages stop requesting animation repaints.

Touch the **glowing orb** to enable voice and hand control. The browser requests
microphone and camera access, and the local wake model loads. Say **Marbles**,
then describe your task. Voice returns to wake mode after assignment or 20
seconds without speech. Touch the orb again to pause both microphone and camera.
There are no navigation tabs, typed composer or persistent button bars.
Mouse and keyboard remain available as accessibility fallbacks.

A gesture recognition widget stays visible on the canvas. It shows camera
status before activation, live hand outlines after tracking starts, and feedback
for pointing, pinching, two-hand zoom and mouse takeover. Camera errors are
visible here. The orb remains the single start/pause control for voice and hands.

Live speech and replies appear at the bottom left, with at most three recent
bubbles. They stay until newer messages replace them, rather than fading while
someone is reading. Completion messages include the agent reply and a link to
full task details. Agent/task details stay open when the pointer moves away;
technical activity and diagnostics are expandable.

Completed deliverables appear beside their producing agent as holographic
file objects. Documents, spreadsheets, slides and images have distinct glyphs;
multiple files form one stack. Point and pinch a stack to browse its files, then
select a file to preview it inside the canvas. PDFs render as scrollable pages; images, audio and video use embedded viewers. HTML uses a sandboxed in-place view with relative styles/images. CSV/TSV and XLSX display readable tables, DOCX/ODT display document text, and PPTX/ODP display slide content. Office content previews do not reproduce every native layout or chart. Binary files receive an in-place byte preview rather than opening an external tab.
Dependency/build output stays out of the canvas. Office previews cap tables at 2,000 rows and bound archive expansion; PDFs render pages as they approach the viewport.

After waking Marbles, **show me report.pdf** opens a matching known filename
locally, and **close the preview** returns to the canvas. These viewing commands
never launch another agent. Duplicate filenames require selecting the intended
file; unknown targets follow the existing task interpretation path.

Standby wake recognition uses quantized `Xenova/whisper-tiny.en` in a browser
worker via Transformers.js (Apache-2.0 model). A setup script installs the pinned
model and matching ONNX runtime under
`app/public` and serves them from localhost. `npm run dev`, `npm run client`, and
`npm run build` run setup automatically; `npm run setup:wake` can also be run
explicitly. Setup needs network access once, then reuses the verified file sizes.
The browser never downloads wake assets from Hugging Face or a CDN. Generated
model/runtime files are gitignored and copied into production builds. It runs one
inference at a time over overlapping audio
windows, gated by local audio energy, with bounded history. A **50% normalized
edit-similarity** match to the individual word **Marbles** opens OpenAI
transcription. The detector scans every word in a sentence, so "hey Marbles",
"hi Marbles", "yo Marbles", and longer sentences work without requiring a
particular greeting. Close word transcriptions such as "marvels" and "marble"
are accepted. It prefers the clearest match, then the earliest occurrence,
so later request words do not displace an exact wake word. This is text
similarity, not a calibrated acoustic confidence score. Saying the wake
phrase alone gets a spoken acknowledgement without launching a task.
Segment timestamps preserve the utterance containing the wake word while dropping
earlier room/playback audio. Missing timestamps fall back to the audible onset
instead of rejecting an otherwise recognized wake word. OpenAI removes the wake
prefix from the final command transcript.
This is local ASR-based wake recognition rather than a trained keyword-only
model; latency and accuracy depend on the device, accent, and room noise.
An isolated inference failure retries with a fresh window after a short backoff.
Repeated failures show the actual runtime error. Each window is decoded once with
segment timestamps, avoiding a second word-alignment decode. The detector accepts
quieter input (RMS 0.0015), applies bounded gain only to the local recognition copy,
and performs a final check with 300 ms of trailing silence. If speech ends while
inference is busy, the next window stays pinned to that speech instead of skipping
it because the room has gone quiet. Quiet input alone still cannot open the cloud
gate; the transcript must contain the wake word at the configured similarity.

After wake-up, an adaptive sound trigger commits phrases after 700 ms of quiet
and caps continuous turns at 15 seconds. Mono 24 kHz PCM streams to hosted
`gpt-live-transcribe` through the server. Standby audio stays local; command audio
is sent to OpenAI. Initial command audio is buffered and paced, with a bounded
backlog and visible errors if the connection cannot keep up.

Final replies are read with OpenAI `gpt-4o-mini-tts`, Marin voice, through
`POST /api/voice/speech`. Marin is used for automatic replies and **Read aloud**;
previously saved browser voice choices are ignored. There is no voice picker.
The wake word interrupts playback; **Read aloud** replays a message. Text stays visible
if audio fails or the browser blocks playback. Code blocks and URLs are simplified
for speech and long replies are shortened. Up to three replies queue, with three
clips cached in memory. The voice is AI-generated. Text-to-speech uses the same
server-side key and incurs OpenAI API usage. This Speech API model is supported
until its announced January 6, 2027 shutdown; migrate this endpoint before then.

While a reply plays, microphone audio is held out of cloud transcription. The
local wake detector remains available, so **Marbles** interrupts playback and
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

The existing TaskService chooses an installed, supported, idle Codex, Claude, or Cursor
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

To enable Cursor tasks, install its headless CLI with
`curl https://cursor.com/install -fsS | bash` and run `cursor-agent login`.
Marbles detects `cursor-agent` or Cursor's newer `agent` command. Cursor.app
without the CLI remains visible but cannot launch tasks. Cursor logs in Marbles
come from captured task or swarm stream output; no previous Cursor session log
is available before a Marbles run.

Spoken status questions such as “what's happening with Codex?” and log requests
such as “give me the log” report recent activity without starting a run. The
reply appears in the conversation and uses the existing speech playback.
`POST /api/assistant/ask` accepts `{ "question": "what is Codex doing?" }` from
the same local app origins as voice commands and uses the same intent path.

The relay accepts one voice session from local app origins on ports 5173/5174.
The server binds to loopback and limits payloads, backlogs, and session duration. Closing sockets do not reserve the voice
slot; heartbeat cleanup removes abandoned connections. Initial connection handshakes
retry up to three times without replaying audio from an established session.
Before sharing this server, add authentication and explicit origin configuration.
Keep the frontend on port 5173. The key, audio, and local configuration are never
committed; transcripts and generated prompts remain in the server task history.

API references: [live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
and [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Next

Richer parsing (remark AST, frontmatter), search/focus, graph layout polish.

## Floating result presentations

When a live task or swarm completes, its lead agent moves beside a floating
screen and presents the generated files in place. If files are discovered after
the completion status, the presentation waits for them. Old completed history
does not replay on page load.

Use the screen’s arrows or voice to open another known file. Close with the
corner control, Escape, or **Marbles, close it**. The screen folds back toward
the agent before the agent glides to its home slot. Files remain on the canvas
and can be reopened. Simultaneous completions queue and never replace an active
presentation or an unrelated detail surface being read. Gesture pan and zoom
apply to the open reader; motion preferences disable animated transitions.

## Scenarios

The office scenario harness compares independent solo attempts with a shared
swarm at the same number of agent runs. Eight deterministic fixtures cover
summaries, expenses, sales, policy changes, offsite planning, split roster
information, log search, and email triage. Each mode is scored by a local rubric;
the reward also discounts captured output length. Run the fake agent pipeline
without CLI usage:

```sh
cd app
npm run scenarios -- --dry-run
npm run scenarios -- --dry-run --scenarios=meeting-summary,split-info-roster --agents=codex,claude --keep
```

Results are written to `scenario-results/<timestamp>.jsonl`, a matching Markdown
report, and `scenario-results/latest.md`. Workspaces under
`MARBLES_WORKSPACE_DIR/scenarios/<runId>/` are removed after scoring unless
`--keep` is set. Omit `--dry-run` to run installed CLI agents. `POST /api/route`
returns the cheap solo or swarm decision; `POST /api/tasks/auto` applies it.
`POST /api/scenarios/run` starts a background run and returns an id; poll
`GET /api/scenarios/runs/:id` for progress.

## Swarm mode

Ask by voice for agents to work together, for example: “Marbles, work as a team to prepare this report.” A
swarm runs 1–4 supported CLI agents in one workspace under
`MARBLES_WORKSPACE_DIR/swarms/<id>/`. They receive the same prompt, coordinate
through a server merged blackboard, and place joint deliverables in `shared/`.
The detail panel shows runs, posts, files, evaluation, and one shared team reward.
`POST /api/swarm/tasks` accepts `{ "goal": "...", "agents": ["codex", "claude"],
"mode": "swarm" }`; omit agents for reward guided selection, or use
`"mode": "best-of-n"` to compare independent solo runs. History, lessons, and
selection statistics persist in the workspace root.
