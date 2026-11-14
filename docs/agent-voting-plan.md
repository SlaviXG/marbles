# Agent voting for Marbles (v1)

## Goal and boundary

Turn one user request into one owned execution. Eligible agent nodes (Codex, Claude Code, and later adapters) each submit a short bid; the server chooses one winner and runs that agent. The canvas shows who bid, who won, what the winner is doing, and the result. A task has at most one executing agent. There is no decomposition, delegation, agent-to-agent handoff, or multi-agent orchestration in v1. Losing agents do not execute or review the task.

This is a new workflow beside the existing knowledge graph, not a reinterpretation of notes. Today `app/src/core/graph.ts` derives `note`, `section`, and `url` nodes from `Note` records; `app/src/views/GraphView.tsx` draws small circles on a force graph and does manual hit testing; `app/src/state/store.ts` owns the vault notes and selected ID. The proposed task and agent state must be independent of the vault so changing a folder snapshot cannot erase a running task.

## Request path

1. Add a task composer in `app/src/App.tsx`, above the graph. Text submission sends the trimmed user wording to `POST /api/tasks`. Voice uses a press-to-record control and a transcription adapter; on recognition, show the transcript in the same composer for correction and explicit submission. Both paths produce the same `TaskRequest` with `source: "text" | "voice"`. Empty transcripts and empty text are never submitted. Keep transcription credentials and provider calls on the server (`POST /api/transcribe`); the browser sends audio, receives text, and never receives provider secrets. If voice is unavailable, text remains usable.
2. The HTTP handler in `app/server/transport/createApp.mjs` validates the request, returns `202 { taskId }`, and asks a new `AgentTaskService` to create the task. The service writes a task event, opens a bounded bid window, picks one agent, and starts a runner. Generate the task ID on the server; use a client submission ID for retry deduplication so a network retry cannot start the task twice.
3. Add an agent/task snapshot endpoint and SSE events alongside the existing vault endpoint and `/api/stream`. `app/src/hooks/useVaultStream.ts` currently handles only `snapshot`, `update`, and `remove` for notes; use a separate `useAgentStream` hook and agent store. Send a snapshot on connect and monotonic event sequence numbers afterward. On reconnect, reload the snapshot to repair gaps. The existing Vite `/api` proxy in `app/vite.config.ts` already covers these routes.

The server is the authority for bidding, ownership, and execution. A client may disconnect without stopping a task. The server must stay running for v1 execution; persistence across a server restart is a later decision (see open questions).

## Agent and task nodes

Register each installed, enabled runner as an `AgentInstance`, for example `pushkar-codex` or `pushkar-claude-code`. A provider label is display data; the stable ID identifies the local runner and its capability/availability configuration. An adapter interface lets other agents join without changing the vote protocol. Registry state belongs in the server, with safe public fields sent to the client; CLI paths, credentials, and private settings stay server-side.

Extend `GNode` in `app/src/core/graph.ts` to a discriminated union of the current knowledge nodes plus `agent` and `task` nodes. Keep the existing `buildGraph(notes)` behavior, then compose in agents and recent tasks from the separate store. Prefix new IDs (`agent:<id>`, `task:<id>`) because note IDs are paths and URL IDs are raw URLs. Add links from a task node to candidates while voting and retain a highlighted task-to-winner link after selection. Cap displayed task history (for example, the current task plus 20 recent tasks) so the force simulation stays responsive; history can remain available in the task panel.

`GraphView.tsx` must add `agent`/`task` entries to its color, drawn radius, hit radius, collision force, and magnet geometry. Its current cache keyed by node ID can retain positions across status updates. The current circles cannot hold paragraphs, so an agent node should draw a compact card at readable zoom: name, status, current task title, and a short progress line; at low zoom show a labeled glyph with a status ring. The task node shows its title and state. Hit testing must cover the card bounds, not just the old circular radius. Do not repaint the whole graph for every streamed log fragment; throttle visible progress updates and keep full activity in the detail view.

`app/src/core/detail.ts` and `app/src/views/DetailPanel.tsx` currently resolve only vault note/section/URL IDs. Add agent and task detail variants from the agent store. Reuse selection and the existing immersive panel, but resolve a prefixed ID before the note resolver. The panel can show the full context that will not fit on the canvas.

## Vote protocol

For each new task, freeze one candidate set of healthy, enabled, idle runners whose declared capabilities cover the request. Do not include a runner already executing a task. If capability filtering cannot establish a match, allow all general-purpose runners to bid. Each candidate receives the same task text, source, declared working context, and relevant user-selected graph references. Bids are **assessments only**: the bid call has no write tools or task execution permission.

Each candidate answers once within an 8-second bid deadline with `accept`, confidence from 0 to 1, and a self-assessment of at most 160 characters explaining fit or a blocker. `accept: false` is a decline and must include a reason. A malformed, late, or failed bid is recorded as unavailable for this vote. The server collects bids concurrently and closes the vote when all have answered or the deadline passes. It displays every received bid on the agent node and task detail, including declines and timeouts. These confidence values are self-reported, not calibrated probabilities.

Choose among accepted bids with confidence at least 0.55. Highest confidence wins; scores within 0.05 are treated as tied, then prefer the runner with fewer completed assignments in the current session, then stable agent ID lexical order. Make the choice once on the server and persist the winner ID and ranking in the task record. If no qualifying bid arrives, mark the task `unassigned` with the specific reasons and keep the request visible for user retry or direct assignment. Do not silently start a runner that declined or timed out.

If the chosen runner fails to start before any task action, try the next qualifying bid in ranked order and record the replacement. Once execution has begun, a crash, timeout, or failed task ends this attempt as `failed`; never launch a second agent automatically, because repeating side effects may be unsafe. A user retry creates a new task linked to the previous attempt. A hard execution limit and an inactivity limit are configurable (suggest 30 minutes and 5 minutes initially); on either limit, request cancellation, then terminate the runner if necessary, and report `timed_out`. A cancel action targets only the winner. All transitions should be idempotent so duplicate events cannot create two winners or two processes.

## Winner execution and visible context

Add a runner adapter with two operations: `bid(context, signal)` and `execute(context, onEvent, signal)`. The server implements adapters for the locally installed Codex and Claude Code CLIs, then adds other providers by implementing the same port. Verify each CLI's noninteractive invocation and output format during implementation; do not parse a human terminal screen as the protocol. Launch only the winner under the configured workspace and local permissions. For code changes, use the per-task worktree convention described in the root `README.md`; for other tasks, supply an appropriate task workspace. The runner gets the exact submitted request and the selected graph context, not the whole vault by default.

Normalize runner output into `started`, `progress`, `result`, `failed`, and `cancelled` events. Progress should contain a short human-readable activity line, timestamp, and optional safe artifact references. Stream these events to the agent store over SSE. On the canvas, show the winner ring and latest activity; in its detail panel show the task, bid rationale/confidence, elapsed time, recent activity, result/error, and links to produced artifacts. The task panel shows all bids, selection reason, winner, and final result. Keep raw model traces and secrets out of the public stream; cap activity history and output sizes, and expose only allowed summaries/paths.

The agent node's context should have two levels:

- **On canvas:** agent name/provider, `idle | bidding | running | unavailable`, current task title, bid confidence or decline marker while voting, and one-line progress when running.
- **In detail:** capabilities/availability, current task's original request and source, the graph references actually passed to the runner, bid text and decision, current phase, timestamped activity, final result/artifacts, and recent task history. Other agents' private runtime context and credentials are not shown.

## Proposed TypeScript contract

Put the shared public contract in `app/src/core/agentTypes.ts` and use it for client state and HTTP/SSE payloads. The server is currently `.mjs`, so mirror the contract with runtime validation at the transport boundary; do not assume a TypeScript interface validates incoming JSON.

```ts
export type TaskSource = "text" | "voice";
export type TaskStatus =
  | "voting" | "unassigned" | "starting" | "running"
  | "completed" | "failed" | "timed_out" | "cancelled";
export type AgentStatus = "idle" | "bidding" | "running" | "unavailable";

export interface GraphReference {
  nodeId: string; // existing note/section/URL ID, selected by the user
  label: string;
}
export interface TaskRequest {
  text: string;
  source: TaskSource;
  clientSubmissionId: string;
  references: GraphReference[];
}
export interface AgentInstance {
  id: string; // e.g. pushkar-codex; graph ID is agent:${id}
  provider: string;
  label: string;
  capabilities: string[];
  status: AgentStatus;
  activeTaskId: string | null;
  lastProgress: string | null;
}
export interface AgentBid {
  taskId: string;
  agentId: string;
  accept: boolean;
  confidence: number | null; // 0..1 when accepted
  assessment: string; // <= 160 characters
  state: "received" | "declined" | "timed_out" | "error";
  at: string; // ISO timestamp
}
export interface TaskActivity {
  seq: number;
  at: string;
  kind: "started" | "progress" | "result" | "failed" | "cancelled";
  message: string;
  artifactRefs?: string[];
}
export interface AgentTask {
  id: string; // graph ID is task:${id}
  request: TaskRequest;
  status: TaskStatus;
  candidateIds: string[];
  bids: AgentBid[];
  winnerId: string | null;
  selectionReason: string | null;
  activity: TaskActivity[];
  createdAt: string;
  updatedAt: string;
  retryOf?: string;
}
export type AgentStreamEvent =
  | { seq: number; type: "snapshot"; agents: AgentInstance[]; tasks: AgentTask[] }
  | { seq: number; type: "agent"; agent: AgentInstance }
  | { seq: number; type: "task"; task: AgentTask };
```

The `GNode` extension should retain `{ id, label, type }` for every variant, with `type: "agent" | "task"` and a domain ID or reference for lookup. Keep `GLink`'s `{ source, target }` shape so the existing force graph still accepts it. Do not put mutable progress arrays on force simulation node objects; look them up by stable ID in the agent store.

## File-level build sequence

1. **Contracts and state:** add `app/src/core/agentTypes.ts`, an agent/task Zustand store beside `app/src/state/store.ts`, and graph composition in `app/src/core/graph.ts`. Add focused tests for namespaced IDs, links, and unchanged note graph behavior in `app/src/__tests__/graph.test.ts`.
2. **Read-only canvas:** render seeded agent/task fixtures in `app/src/views/GraphView.tsx`, add detail variants in `app/src/core/detail.ts` and `app/src/views/DetailPanel.tsx`, and style the composer/cards in `app/src/styles.css`. Verify selection, hit testing, labels, and hand-pointer magnet behavior at low and high zoom.
3. **Server lifecycle:** add a registry, `AgentTaskService`, vote selector, runner port, and event stream under `app/server/agents/`; wire them in `app/server/index.mjs` and add task, snapshot, stream, and cancel routes in `app/server/transport/createApp.mjs`. Test bid deadlines, ties, no bids, duplicate submission IDs, start fallback, and the no-second-run rule after execution begins.
4. **Client live path:** add `app/src/hooks/useAgentStream.ts`, the task composer in `app/src/App.tsx`, and status/progress rendering. Send typed task requests, recover from SSE reconnects with a snapshot, and make each task's server state visible even if the browser reloads.
5. **Real runners:** connect Codex and Claude Code adapters, then test one task with both bidding and only the selected runner executing. Check cancellation, process cleanup, bounded progress, and file output in an isolated workspace. Add an adapter only after its bidding and execution formats are verified.
6. **Voice path:** add transcription endpoint and press-to-record UI, reviewable transcript, and the same submit path used by text. Test an unclear transcript, user edit, failed transcription, and a final task that records `source: "voice"`.

## Open questions

- Which installed agent CLIs and execution permissions should be enabled on each machine, and how should a runner declare capabilities? The registry should be configured rather than inferred from the display name.
- Which transcription provider and browser capture path should voice use, and what audio retention policy is acceptable?
- Should task history and event sequence survive a server restart? In-memory state is enough for the first local prototype but cannot recover a running process after restart.
- How should the user choose graph references to attach to a request, and how much note content may the server pass to runners after the user selects them?
- What counts as a user-visible artifact for non-code tasks, and should completed task nodes remain on the canvas or move to history after the display cap?
- Should users be able to choose an agent directly when voting leaves a task unassigned? That would be an explicit new attempt, not a hidden fallback.
