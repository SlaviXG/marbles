import { describe, it, expect, vi } from 'vitest';
import { classifyQuery, VoiceCommands } from '../agents/voiceCommands.mjs';
import { gatherStatus, summariseStatus } from '../agents/statusReporter.mjs';
import { createApp } from '../transport/createApp.mjs';

const agent = id => ({ id, name: id, kind: 'cli', path: `/bin/${id}`, available: true });
const registry = { snapshot: () => [agent('codex'), agent('claude'), { ...agent('cursor'), kind: 'desktop' }] };
const task = { agentId: 'codex', title: 'Build report', status: 'running', createdAt: new Date().toISOString(), stdout: 'starting\nDone with sk-abcdefghijklmnop' };
const tasks = { snapshot: () => [task], isBusy: id => id === 'codex', start: vi.fn(), startIdle: vi.fn(), root: '/tmp' };
const swarms = { snapshot: () => [{ goal: 'Review', status: 'completed', agents: ['codex', 'claude'], reward: 0.8, blackboard: [{ agentId: 'claude', kind: 'done', text: 'password=private' }] }], isBusy: () => false, start: vi.fn(), statsSnapshot: () => ({}) };
const readLog = vi.fn(async () => ({ available: true, prompt: { text: 'token=private', at: null }, messages: [{ text: 'Done', at: null }], tools: [] }));

describe('status and log questions', () => {
  it.each([
    ["what's happening with Codex?", 'status', ['codex']],
    ['what is Codex doing?', 'status', ['codex']],
    ['what are codex and claude doing together', 'status', ['codex', 'claude']],
    ['show me Cursor output', 'log', ['cursor']],
    ['give me the log', 'log', []],
    ['make a report', 'task', []],
    ['have codex and claude work together on a report', 'swarm', ['codex', 'claude']],
  ])('classifies %s', (text, intent, targetAgents) => {
    expect(classifyQuery(text)).toEqual({ intent, targetAgents });
  });

  it('gathers bounded, redacted context and offers a template without an API key', async () => {
    const context = await gatherStatus({ targets: [], agentRegistry: registry, taskService: tasks, swarmService: swarms, readLog, includeLogs: true });
    expect(context.agents.find(a => a.id === 'cursor')).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Cursor CLI not installed') });
    expect(context.tasks[0].lastOutput).toContain('[redacted]');
    expect(context.swarms[0].blackboard[0].text).toContain('[redacted]');
    expect(JSON.stringify(context)).not.toContain('private');
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(6000);
    expect(await summariseStatus(context, { apiKey: '', question: 'status' })).toContain('codex');
  });

  it('calls Responses with bounded output and falls back after failure', async () => {
    const context = { agents: [{ id: 'codex', name: 'Codex', status: 'idle' }], tasks: [], swarms: [] };
    const fetchApi = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'Codex is idle.' }] }] }) }));
    expect(await summariseStatus(context, { apiKey: 'test', fetchApi, question: 'status' })).toBe('Codex is idle.');
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toMatchObject({ store: false, max_output_tokens: 400 });
    expect(await summariseStatus(context, { apiKey: 'test', fetchApi: async () => { throw new Error('offline'); } })).toContain('idle');
  });

  it('answers status and log without launching a task or swarm', async () => {
    const interpret = vi.fn();
    const commands = new VoiceCommands({ taskService: tasks, swarmService: swarms, agentRegistry: registry, readLog, summarize: async () => 'Codex is working.', interpret });
    for (const [text, state] of [['what is codex working on?', 'status'], ['give me the codex log', 'log']]) {
      const result = await commands.dispatch({ transcript: text, requestId: crypto.randomUUID() });
      expect(result).toMatchObject({ state, reply: 'Codex is working.', context: { agents: expect.any(Array), tasks: expect.any(Array), swarms: expect.any(Array) } });
    }
    expect(interpret).not.toHaveBeenCalled();
    expect(tasks.start).not.toHaveBeenCalled();
    expect(tasks.startIdle).not.toHaveBeenCalled();
    expect(swarms.start).not.toHaveBeenCalled();
  });

  it('serves typed questions with the same local origin guard and cursor log route', async () => {
    const commands = { dispatch: vi.fn(async () => ({ state: 'status', reply: 'Idle' })) };
    const app = createApp({ snapshot: () => ({}), onChange: () => () => {} }, { agentRegistry: registry, taskService: tasks, swarmService: swarms, voiceCommands: commands });
    const route = (method, path) => app._router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
    const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
    let res = response(); await route('post', '/api/assistant/ask')({ headers: { origin: 'https://remote.test' }, body: { question: 'status' } }, res);
    expect(res.statusCode).toBe(403);
    res = response(); await route('post', '/api/assistant/ask')({ headers: { origin: 'http://localhost:5173' }, body: { question: 'status' } }, res);
    expect(res.body).toMatchObject({ state: 'status', reply: 'Idle' });
    res = response(); await route('get', '/api/agents/:id/log')({ params: { id: 'cursor' } }, res);
    expect(res.body).toMatchObject({ available: false, reason: expect.any(String) });
  });

  it('reads the newest captured Cursor task or swarm stream for the log route', async () => {
    const row = text => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    const cursorTask = { agentId: 'cursor', createdAt: '2026-01-01T00:00:00Z', stdout: row('task output') };
    const taskService = { ...tasks, snapshot: () => [cursorTask] };
    const swarmService = { ...swarms, snapshot: () => [{ runs: [{ agentId: 'cursor', startedAt: '2026-01-02T00:00:00Z', stdout: row('swarm output') }] }] };
    const app = createApp({ snapshot: () => ({}), onChange: () => () => {} }, { agentRegistry: registry, taskService, swarmService, voiceCommands: { dispatch: vi.fn() } });
    const handler = app._router.stack.find(layer => layer.route?.path === '/api/agents/:id/log').route.stack[0].handle;
    const res = { json(body) { this.body = body; return this; }, status() { return this; } };
    await handler({ params: { id: 'cursor' } }, res);
    expect(res.body).toMatchObject({ available: true, messages: [{ text: 'swarm output', at: null }] });
  });
});
