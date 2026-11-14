# marbles

marbles is a multi-purpose extension that uses multi-agent swarms to automate tasks driven by voice.

## Key ideas

- **Voice-driven:** Use voice to drive task automation.
- **Multi-agent swarms:** Coordinate multiple agents to work on tasks.
- **Multi-purpose:** Support a range of tasks through one extension.

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
