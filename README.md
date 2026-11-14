# marbles

marbles is a virtual office for your coding agents: a 2D board where your own
Claude Code and Codex agents sit, with their work and logs visible, steered by
voice and hands. Each agent is a desk you can point at, redirect, stop, and open
to read its full log and changed files.

Built at the Imperial AI Society Flagship Hackathon, 14 to 15 November 2026
(Voice, Vision and Generative Media track).

## Key ideas

- **Direct a team, don't operate a computer:** the prompt box was built for one model; several agents need a different interface.
- **Your own agents:** marbles starts the `claude` and `codex` command-line tools you already have installed, with your own logins.
- **Voice and hands:** one spoken sentence starts an agent; a pinch plus a sentence redirects it. The mouse always works as a fallback.
- **Visible work:** every desk shows the agent's task, state and latest log line, and opens to the full log and the files it changed.

## Try the UI

Runs locally. Use Chrome or Edge: the folder picker and the hand cursor rely on
APIs that Firefox and Safari lack.

```sh
git clone https://github.com/SlaviXG/marbles && cd marbles/app
npm install
npm run client     # UI only, http://localhost:5173
```

> **Test nodes.** Four dummy notes titled `[TEST] Alpha`, `[TEST] Beta`,
> `[TEST] Gamma` and `[TEST] Delta` are hardcoded so the graph is never empty.
> They are not real data and appear next to any vault or folder you load (the
> status pill counts them separately as `· 4 test`). They live in
> [`app/src/core/testNodes.ts`](app/src/core/testNodes.ts); set
> `SHOW_TEST_NODES = false` there to hide them.

### What to test

- **Graph:** click a node to open its detail panel, click another node to switch, click the background to close. `[TEST] Beta` and `[TEST] Delta` share a URL node, which should list both.
- **Your own notes:** click **open folder** (bottom right, above the hand button) and pick any folder of `.md` files. Edit a file and the graph updates within a couple of seconds.
- **Hand cursor:** click the hand button (bottom right) and allow the camera. Point with your index finger, pinch to click, pinch and move to drag, pinch with both hands to zoom or pan. **R/L** picks the primary hand; the skeleton button shows tracked landmarks. Moving the mouse takes the cursor back.
- **Hand library alone:** `cd app/lib/hand-pointer && npm install && npm run demo`.
- **Unit tests:** `npm test` (and `npm run typecheck`) in `app/`.

### With an Obsidian vault (live server)

```sh
cp .env.example .env   # in the repo root; set OBSIDIAN_VAULT_DIR to an absolute vault path
cd app && npm run dev  # server :5174 + client :5173
```

`npm run dev` needs a valid `OBSIDIAN_VAULT_DIR`; without one the server exits
and stops the client with it, so use `npm run client` instead. More detail in
[`app/README.md`](app/README.md).

## Hackathon spec

The goal is a two-minute demo that works many times in a row: a board showing
3 to 5 real Claude Code and Codex agents working, where one spoken sentence
starts an agent and a pinch plus a sentence redirects it. Anything that does not
appear in the demo is out.

### Scope

| Feature | Status | Done when |
| --- | --- | --- |
| Agents as desks on a 2D board | Must | Each running agent shows its name, tool, task, state and latest log line |
| Start an agent by voice | Must | "New agent, fix the login bug" creates a desk and a real agent run; a typed box does the same |
| Point at an agent and redirect it by voice | Must | Pinch selects a desk; the next sentence reaches that agent mid-run |
| Open a desk to read the work | Must | Shows the full log in time order and the files changed |
| Stop an agent | Must | By voice or a button; the state updates on the board |
| Real output | Must | At least one agent finishes a change you can see in the repository or a preview |
| Reset | Must | One key restores a clean board |
| Lip-activated microphone | Should | The microphone opens only while the nearest face's lips move |
| Agent asks for a decision | Should | A waiting agent raises a flag on its desk; pinch to answer |
| Generated portrait per agent (fal) | Could | Each desk shows an image created when the agent starts |
| Agents messaging each other, pods, custom agents, sandboxes, hardware, full lip reading | Out | Later, see [After the hackathon](#after-the-hackathon) |

### Architecture

Four parts talk over one event stream, so each layer can be built against the
contract without waiting for the others.

- **Input.** The in-repo hand-pointer library (`app/lib/hand-pointer`) emits standard pointer events, so the board cannot tell a hand from a mouse. Speech goes to OpenAI live transcription through a local WebSocket at `/api/voice`.
- **Board.** A React and Vite app in `app/src`: a force graph of agent, task and file nodes, a detail panel, and a YouTube preview with hand-usable controls.
- **Server.** A local Node and Express process in `app/server`, bound to `127.0.0.1`. It detects installed agents, starts tasks, reads output and serves files.
- **Agents.** The user's own installed command-line tools, started directly: `claude -p` and `codex exec`, each task in its own folder under the workspace directory.
- **Speech output.** ElevenLabs text-to-speech, for short spoken status lines.

The hand-pointer library predates the event; everything else was built during
the hackathon.

### Event contract

| Direction | Event | Payload |
| --- | --- | --- |
| Runtime to canvas | `agent.spawned` | id, name, role, parent |
| Runtime to canvas | `agent.status` | id, state (thinking, working, blocked, done), current task |
| Runtime to canvas | `message.sent` | from, to, text |
| Runtime to canvas | `tool.called` / `tool.result` | id, tool, input summary, output summary, source URL |
| Runtime to canvas | `agent.proposal` | id, text, options |
| Runtime to canvas | `mission.done` | artefact link, totals |
| Canvas to runtime | `mission.start` | brief text |
| Canvas to runtime | `agent.redirect` | id, instruction |
| Canvas to runtime | `pod.merge` | ids |
| Canvas to runtime | `proposal.answer` | id, choice |
| Canvas to runtime | `agent.stop` | id |

Every event also carries a timestamp and a sequence number. The runtime writes
the full stream to a file so any run can be replayed into the board. For this
build, `mission.start` means start one agent on one task, and `message.sent`,
`agent.proposal`, `pod.merge` and `proposal.answer` are optional.

Contract changes need all three owners to agree; nobody adds a field alone.

### Where the code is (14 Nov, 16:00)

All three layers exist, on branches that have not yet run together on `main`.

| Branch | Owner | What it has |
| --- | --- | --- |
| `main` | Slava | Graph board, hand-pointer library with tests, detail panel, YouTube preview, test nodes |
| `pushkar-codex/agent-voting` | Pushkar | Agent detection, a task service that starts `codex exec` and `claude -p`, log reader, agent, task and file nodes |
| `codex/live-voice-transcription` | Chingis | Built on the agent branch: OpenAI live transcription over `/api/voice`, a floating voice marble, spoken requests delegated to an idle agent |

Endpoints on the agent branch: `GET /api/agents`, `GET /api/tasks`,
`POST /api/agents/:id/tasks`, `GET /api/agents/:id/log`,
`GET /api/artifacts/file`, `POST /api/artifacts/open`. The board polls them
every 5 seconds.

### Gaps to close, in order

1. Merge both branches into `main`. Keep the listen line in `app/server/index.mjs` that binds to `127.0.0.1`.
2. Turn a finished transcript into a command: one model call with three tools (start a task on a named agent, open a URL on the board, stop an agent).
3. Keep the child process in the task service and add stop (kill) and redirect (stop, then a new task in the same folder).
4. Stream agent output: run both tools with their streaming JSON output and push it through `/api/stream`, so a desk moves while its agent works.
5. Show each task its own log. The log reader takes the newest file per provider, so two agents of one kind show the same log; read the task's own streamed output instead.
6. Make the Obsidian vault optional. The server exits when `OBSIDIAN_VAULT_DIR` is missing.
7. Add a reset key that clears tasks and restores a clean board.

### Owners

| Owner | Layer | Next deliverables | Code lives in |
| --- | --- | --- | --- |
| Slava | Modalities and board | Agent, task and file nodes working with pinch and drag; video preview draggable; reset key; lip-activated microphone if time allows | `app/src/views`, `app/lib/hand-pointer` |
| Chingis | Web app and glue | Merge of the branches; transcript to command; ElevenLabs speech output | `app/src/voice`, `app/server/transport` |
| Pushkar | Agents | Stop and redirect; streaming output over `/api/stream`; per-task logs; vault made optional; demo repository | `app/server/agents` |

`main` always runs the demo script, even if ugly. Keep keys out of the
repository and commit often.

### Demo script

1. Say "Open the Wintergatan Marble Machine video." It appears on the board; pinch and drag it to the top right corner.
2. Say "Claude, add a dark mode toggle." A task node appears and files start to gather around the agent.
3. Start a second task on Codex.
4. Pinch the first agent and say "Stop, write the tests first." Its log shows the change of course.
5. Open a finished task and show its log and files.
6. Press reset.

### Cut order if behind

1. Generated portraits
2. Agent asks for a decision
3. Lip-activated microphone
4. Hand tracking during the demo (use the mouse)
5. Codex (run Claude Code only)

Never cut: live desks, start by voice, redirect by voice, the log panel, reset.

### Decided against

- **Agent voting** (`docs/agent-voting-plan.md` on the agent branch): agents bidding for each task adds a wait and is not in the demo. Name the agent in the command, or default to one.
- **Paradev:** the server already starts the agents directly.
- **Full lip reading:** only lip movement as a microphone gate, if time allows.

## After the hackathon

The hackathon build is the first slice of the full product, not a separate one:
the runtime, event contract, canvas and gesture input all carry over. The full
version is a workspace where one person directs dozens of agents, shipped as a
desktop app first.

| Layer | Hackathon build | Full version adds |
| --- | --- | --- |
| Interface | Board, pinch, drag, voice | Hotkey widget, two-hand gestures, agents that propose actions unprompted, themes, multi-surface display |
| Agent workspace | The user's Claude Code and Codex agents | Any command-line agent, cloud machines, browser and desktop control |
| Coordination | None; the user directs each agent | A router that picks hierarchy, pod or hybrid per task |
| Trust | Log panel, sources | Approval gates for irreversible actions, per-agent budgets, full replay, audit log |
| Memory | None | Saved missions, a shared knowledge graph across agents, the existing linked-notes canvas |
| Evidence | None | A benchmark: hierarchy against pod against hybrid on success, tokens, duplicated work and latency |
| Hardware | Laptop and projector | A device with projector, camera and microphone, after software traction |

## Status

marbles is a hackathon prototype under active development; this README tracks
the current plan and will change as the branches land on `main`.

## Contributing

Contributions and ideas are welcome as the project takes shape.
