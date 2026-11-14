import { gatherStatus } from './statusReporter.mjs';
import { agentLog } from './logs.mjs';
import { ClaudeCoordinator, conciseReply } from './ClaudeCoordinator.mjs';
export { buildVoicePrompt } from './ClaudeCoordinator.mjs';

export function classifyQuery(transcript) {
  const text = String(transcript ?? '');
  const command = text.trim().replace(/^(?:can|could|would|will) you\s+(?:please\s+)?/i, '').replace(/^use (?:codex|claude(?: code)?|cursor) to\s+/i, '');
  const targets = [...new Set([...text.matchAll(/\b(codex|claude(?: code)?|cursor)\b/gi)].map(match => match[1].toLowerCase().startsWith('claude') ? 'claude' : match[1].toLowerCase()))];
  if (/^(?:please\s+)?(?:make|build|create|write|fix|implement|update|change|add|remove|delete|generate|prepare)\b/i.test(command)) return { intent: /\b(swarm|as a team|all (the )?agents|everyone|work together)\b/i.test(text) ? 'swarm' : 'task', targetAgents: targets };
  if (/what(?:'s| is) (?:happening|going on)|what (?:is|are) .* doing|\bstatus\b|\bprogress\b|how(?:'s| is) .* doing|are .* (?:done|finished|working|doing)|what .* working on/i.test(text)) return { intent: 'status', targetAgents: targets };
  if (/\blogs?\b|recent activity|what did .* do|show me .* (?:output|history)/i.test(text)) return { intent: 'log', targetAgents: targets };
  return { intent: /\b(swarm|as a team|together|all (the )?agents|everyone)\b/i.test(text) ? 'swarm' : 'task', targetAgents: targets };
}

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value);

// The harness owns bounded conversation memory and idempotent request receipts.
export class VoiceCommands {
  constructor({ taskService, swarmService, contextProvider, noteProvider, agentRegistry, readLog = agentLog, summarize, coordinator = new ClaudeCoordinator({ taskService, swarmService, contextProvider, noteProvider, readAgentLog: readLog }) }) {
    Object.assign(this, { taskService, swarmService, coordinator, agentRegistry, readLog, summarizeStatus: summarize });
    this.requests = new Map(); this.conversations = new Map(); this.summaries = new Map(); this.inflight = 0;
  }
  dispatch({ transcript, requestId, conversationId = 'default-chat', selectedId } = {}) {
    if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 6000 || !validId(requestId) || !validId(conversationId) ||
        (selectedId != null && (typeof selectedId !== 'string' || selectedId.length > 1000))) {
      throw new Error('Supply a transcript under 6,000 characters and valid request/conversation IDs.');
    }
    const fingerprint = JSON.stringify({ transcript, conversationId, selectedId });
    const previous = this.requests.get(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID already used for a different request.');
      return previous.promise;
    }
    if (this.inflight >= 4) throw new Error('Too many voice requests. Wait for the current request.');
    this.inflight++;
    let conversation = this.conversations.get(conversationId);
    if (!conversation) {
      if (this.conversations.size >= 50) {
        for (const [id, entry] of this.conversations) if (!entry.pending) { this.conversations.delete(id); break; }
      }
      conversation = { history: [], tail: Promise.resolve(), pending: 0 };
      this.conversations.set(conversationId, conversation);
    }
    conversation.pending++;
    const entry = { fingerprint, settled: false };
    entry.promise = conversation.tail.catch(() => {}).then(async () => {
      const classified = classifyQuery(transcript);
      const readOnly = ['status', 'log'].includes(classified.intent);
      let context;
      if (readOnly) context = await gatherStatus({ targets: classified.targetAgents,
        agentRegistry: this.agentRegistry ?? { snapshot: () => [] }, taskService: this.taskService, swarmService: this.swarmService,
        readLog: this.readLog, includeLogs: classified.intent === 'log' });
      const result = readOnly && this.summarizeStatus
        ? { state: classified.intent, reply: conciseReply(await this.summarizeStatus(context, { question: transcript })) }
        : await this.coordinator.run({ transcript: transcript.trim(), history: conversation.history, selectedId, readOnly, statusContext: context });
      if (readOnly) {
        if (result.state === 'reply') result.state = classified.intent;
        result.context = { agents: context.agents, tasks: context.tasks, swarms: context.swarms };
      }
      if (result.state !== 'ignore') {
        conversation.history = [...conversation.history, { role: 'user', content: transcript.trim().slice(0, 1800) },
          { role: 'assistant', content: JSON.stringify({ reply: result.reply, objective: result.intent?.objective, plan: result.intent?.plan,
            assumptions: result.intent?.assumptions, taskId: result.task?.id, swarmId: result.swarm?.id }).slice(0, 1800) }].slice(-6);
      }
      return result;
    }).catch(error => { this.requests.delete(requestId); throw error; })
      .finally(() => {
        this.inflight--; conversation.pending--; entry.settled = true;
        if (this.requests.size > 200) {
          for (const [id, record] of this.requests) {
            if (record.settled && id !== requestId) this.requests.delete(id);
            if (this.requests.size <= 200) break;
          }
        }
      });
    conversation.tail = entry.promise;
    this.requests.set(requestId, entry);
    return entry.promise;
  }

  summarize({ id, kind = 'task', conversationId = 'default-chat' } = {}) {
    if (!validId(id) || !validId(conversationId) || !['task', 'swarm'].includes(kind)) throw new Error('Invalid result reference.');
    const record = kind === 'task' ? this.taskService.snapshot().find(task => task.id === id) : this.swarmService?.get(id);
    if (!record || record.source !== 'voice') throw new Error('Voice task not found.');
    if (['running', 'evaluating', 'cancelling'].includes(record.status)) throw new Error('Task is still running.');
    const key = `${kind}:${id}`;
    if (!this.summaries.has(key)) {
      const summary = this.coordinator.summarize(record, kind).then(reply => {
        const conversation = this.conversations.get(conversationId);
        if (conversation) conversation.history = [...conversation.history,
          { role: 'assistant', content: `Worker result (${record.status}): ${conciseReply(reply, 25)}` }].slice(-6);
        return { reply: conciseReply(reply, 25) };
      });
      this.summaries.set(key, summary);
      if (this.summaries.size > 200) this.summaries.delete(this.summaries.keys().next().value);
    }
    return this.summaries.get(key);
  }
}
