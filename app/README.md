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
For a separate dev preview, run `npm run client -- --host 127.0.0.1 --port 5188`
with the backend on `:5174`. The local-origin checks for voice and protected
HTTP APIs allow ports 5173, 5174 and 5188; arbitrary preview ports are rejected.

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

Touch the **glowing orb** to enable voice and hand control and grant microphone
and camera access. On later visits with both permissions already granted, hold
your head toward the screen for about 1.2 seconds to wake the controls instead.
The orb shows **Look here to wake**, with a camera-only indicator and Cancel.
First-time permissions or a browser audio-unlock requirement still need a tap.
Once the local wake model loads, say **Marbles**,
then describe your task. Voice returns to wake mode as soon as the request is
submitted, or after 20 seconds without speech. Say Marbles again for follow-up
requests. Looking at the screen never starts or prolongs command listening.
Touch the orb again to pause both microphone and camera; looking cannot undo a
pause. Automatic startup does not open the screen-sharing picker.
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
model/runtime files are gitignored and copied into production builds. The worker
warms up before reporting ready. An adaptive energy gate feeds 1.5-second windows
every 250 ms while speech is present, plus a final window after 250 ms of quiet.
Only the newest window waits while inference is busy; eight seconds of local audio
remain available for the command. Fast decoding uses 12 tokens and estimates the
wake boundary from audio energy. A guarded phonetic match accepts common Marbles
transcriptions while excluding near misses such as “marvelous” and “tables.”
On supported browsers, interim Web Speech recognition races the local Whisper
detector by default. The first match wins and a 1.5-second cooldown prevents
duplicate wakes. Browser recognition may use the browser vendor’s remote speech
service; see [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).
If the browser API is unavailable or fails, local Whisper continues. The command
always comes from the local audio buffer, then OpenAI transcribes it. The orb gives
a short wake pulse. Set localStorage `marbles.debugWake` to `true` for detection
latency, match, score, inference time, and dropped-window logs. Run
`npm run wake:latency` for an offline replay against the local model and two WAV
clips. Accuracy and latency depend on the device, accent, and room noise.

After wake-up, an adaptive sound trigger commits phrases after 700 ms of quiet
and caps continuous turns at 15 seconds. Mono 24 kHz PCM streams to hosted
`gpt-live-transcribe` through the server. Standby audio stays local; command audio
is sent to OpenAI. Initial command audio is buffered and paced, with a bounded
backlog and visible errors if the connection cannot keep up.

Final replies are read through `POST /api/voice/speech`. Set `ELEVENLABS_API_KEY`
in the repository-root `.env` to use ElevenLabs for spoken replies. The default
voice is `DODLEQrClDo8wCz460ld` with model `eleven_flash_v2_5`. Optionally set
`ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID` to override them. The server
streams ElevenLabs MP3 audio as it arrives. If its key is missing or synthesis
fails before audio starts, the server automatically uses OpenAI
`gpt-4o-mini-tts` with Marin. Keep `OPENAI_API_KEY` for speech-to-text and this
fallback. `GET /api/voice/tts-info` reports the configured provider, ElevenLabs
voice ID and model without returning API keys. The orb remains the single
start/pause control, and the wake word interrupts playback. Text stays visible
if audio fails or the browser blocks playback. Code blocks and URLs are simplified
for speech and long replies are shortened. Up to three replies queue, with three
clips cached in memory. The voice is AI-generated. Text-to-speech incurs usage
with whichever provider handles the request.

While a reply plays, microphone audio is held out of cloud transcription. The
local wake detector remains available, so **Marbles** interrupts playback and
opens the next request. Spoken replies replace the literal wake phrase to avoid
self-activation. Synthesis is cancelled on interruption, muting, or unmounting;
audio object URLs and microphone resources are released. The Vite development
server exposes the speech handler directly as well, so updating speech playback
does not require restarting an active agent runner. Neither route exposes the key.

After speech recognition, the actual **Nous Research Hermes Agent** runtime
coordinates the work, powered by **Claude Opus 5.5** through its native Anthropic
provider. Set `ANTHROPIC_API_KEY` in the repo-root `.env`. Install Git, uv, and
Python 3.14, then run `npm run setup:hermes` in `app`. `npm run dev` and
`npm run server` run setup automatically, reusing the installed runtime. `MARBLES_COORDINATOR_MODEL` optionally
overrides `claude-opus-5-5`; `MARBLES_COORDINATOR_EFFORT` selects low, medium (default), or high effort. OpenAI still handles task transcription and the
fallback speech output; the coordinator does not send standby audio to Claude.

Describe the outcome in one sentence. The coordinator selects sensible,
reversible defaults, creates a 1–3 step plan, states key assumptions, and delegates
immediately. It asks one question only for a real missing source, target, or
required authorization. Conversation memory preserves follow-ups and clarification
answers without repeating the original request. Selecting a note, agent, task,
swarm, or artifact supplies its known context, so “use this spreadsheet” can refer
to the actual selected file.

Claude can inspect available agents and their latest session logs, inspect managed
task/swarm output and blackboards, search and read registered vault notes, find
workspace assets, read text/CSV/code files, and request cancellation of managed
work when asked. Binary documents return metadata and a verified path for a worker
to analyze. Asset reads are limited to the task workspace; hidden/credential files,
traversal, and escaping symlinks are rejected. Log credentials are redacted.
Unmanaged CLI session logs are labeled separately from Marbles-managed work.

Hermes `run_agent.AIAgent` owns the reasoning, provider calls, retries, and tool
loop. A small Python stdio adapter registers Marbles tools in Hermes and forwards
their execution to the existing TaskService/SwarmService. There is no custom
JavaScript LLM loop. The source is pinned in `server/hermes/runtime.json`; setup
uses the upstream uv lockfile and Anthropic extra. Its checkout, Python environment,
and dedicated Hermes profile live under gitignored `app/.hermes-runtime/`; the
user’s global Hermes profile is untouched. The small app toolset is directly
visible, with Hermes tool-search deferral disabled for this profile.
One idle worker is the default; explicit team requests and useful collaborative
plans use the existing swarm runner. Reservations prevent voice/manual/swarm races.
Cancellation keeps a worker busy until its process exits. New work uses the
existing per-task workspace under `MARBLES_WORKSPACE_DIR` (default
`~/marbles-workspace`); changing an external project still requires a real target
and the worker's existing access.

After an accepted delegation or final response tool, the adapter requests a
Hermes interrupt at the tool boundary and acknowledges the actual app receipt.
A provider/process failure after acceptance cannot duplicate the work. Spoken assignment and completion notices are limited to 25
words. Full plans and assumptions are under
**Plan & assumptions** and in task details; raw worker logs stay in task details.
Completed voice tasks/swarms get one cached Hermes/Claude result summary, with a short
local fallback if that call fails.

Hermes is bounded to six iterations and a 40-second run budget. The Node bridge
bounds tool calls to twelve and terminates a stuck runtime after 50 seconds; the
voice UI allows 55 seconds for the response. At most four voice requests are
in flight. Summary turns expose no execution tools. Status/log requests remove
delegation/cancellation tools from both Hermes’s schema and the app dispatcher.
Request IDs deduplicate retries, including accepted work, and follow-ups serialize
within each conversation. Memory is kept for up to 50 conversations with six recent
messages each; requests and result summaries retain up to 200 entries. These are
in-memory and reset on server restart. CLI execution uses each worker's existing
login; coordinator and speech API usage are billed separately by their providers.

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

Runtime reference: [Hermes programmatic integration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md).

API references: [live transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
and [Claude tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works).

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
