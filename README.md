# marbles

marbles is a multi-purpose extension that uses multi-agent swarms to automate tasks driven by voice.

## Key ideas

- **Voice-driven:** Use voice to drive task automation.
- **Multi-agent swarms:** Coordinate multiple agents to work on tasks.
- **Multi-purpose:** Support a range of tasks through one extension.

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

## Plan

### Roadmap (from the team's task list)

1. UI with gesture recognition (owner: Joush)
2. Integrate voice AI
3. Integrate agents as nodes and display their context inside each node
4. Test voice AI + agents together
5. Asset generation and display

### Agent observer and transparency

- Learn from [justincc/hobserver](https://github.com/justincc/hobserver): incremental log reader -> event parser -> SQLite index -> session/turn/tool-call timeline, with live updates. Reuse the design, not Hermes-specific code.
- Logs come straight from each agent, no Hermes needed: Claude Code at `~/.claude/projects/<project>/<session>.jsonl`, Codex at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Choosing an agent selects its log folder; the newest file holds its last prompt.
- Show the user where answers come from when they ask: skill and instruction files read (`SKILL.md`, `AGENTS.md`, `CLAUDE.md`), memory used, tools and browser actions (e.g. which booking skill was loaded, which sites were visited), and sources.

### Running agents

- Following [stablyai/orca](https://github.com/stablyai/orca): launch the user's installed `claude` and `codex` CLIs with their own logins/subscriptions (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), one git worktree per agent task.
- Agent naming: `<owner>-<tool>` (e.g. `pushkar-codex`), used in branches, Slack `#agents` posts, and commit trailers.
- Codex is the main builder; Claude Code plans and reviews.

## Status

marbles is early-stage, and this README will evolve as the project develops.

## Contributing

Contributions and ideas are welcome as the project takes shape.
