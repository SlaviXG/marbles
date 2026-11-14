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
microphone permission and loads a local wake model automatically. Say **Marbles**, then describe your task. The marble returns to wake mode after a task
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
**AI voice on/muted** toggles automatic playback;
**Stop reply** interrupts it; **Read aloud** replays a message. Text stays visible
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

After speech recognition, the actual **Nous Research Hermes Agent** runtime
coordinates the work, powered by **Claude Sonnet 5.5** through its native Anthropic
provider. Set `ANTHROPIC_API_KEY` in the repo-root `.env`. Install Git, uv, and
Python 3.14, then run `npm run setup:hermes` in `app`. `npm run dev` and
`npm run server` run setup automatically, reusing the installed runtime. `MARBLES_COORDINATOR_MODEL` optionally
overrides `claude-sonnet-5-5`. OpenAI still handles task transcription and Marin
speech output; the coordinator does not send standby audio to Claude.

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
local fallback if that call fails. **Read aloud** uses the same concise message.

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

Use **Start swarm** in the canvas or ask by voice for agents to work together. A
swarm runs 1–4 supported CLI agents in one workspace under
`MARBLES_WORKSPACE_DIR/swarms/<id>/`. They receive the same prompt, coordinate
through a server merged blackboard, and place joint deliverables in `shared/`.
The detail panel shows runs, posts, files, evaluation, and one shared team reward.
`POST /api/swarm/tasks` accepts `{ "goal": "...", "agents": ["codex", "claude"],
"mode": "swarm" }`; omit agents for reward guided selection, or use
`"mode": "best-of-n"` to compare independent solo runs. History, lessons, and
selection statistics persist in the workspace root.
