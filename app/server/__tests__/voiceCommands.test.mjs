import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VoiceCommands } from '../agents/voiceCommands.mjs';
import { TaskService } from '../agents/taskService.mjs';

const request = { transcript: 'Make a demo plan.', requestId: 'request-123', conversationId: 'conversation-123' };
const result = { state: 'assigned', task: { id: 'task-123' }, intent: { objective: 'Demo plan', plan: ['Draft and verify the plan'], assumptions: ['One page'] }, reply: 'I’ll draft a one-page plan.' };
function setup() {
  const run = vi.fn(async () => result);
  const summarize = vi.fn(async () => 'The plan is ready in demo.md.');
  const record = { id: 'task-1234', source: 'voice', status: 'completed', title: 'Demo plan' };
  const commands = new VoiceCommands({ taskService: { snapshot: () => [record] }, coordinator: { run, summarize } });
  return { commands, run, summarize, record };
}

describe('coordinator memory and receipts', () => {
  it('deduplicates simultaneous retries and rejects changed requests', async () => {
    const { commands, run } = setup();
    const results = await Promise.all([commands.dispatch(request), commands.dispatch(request)]);
    expect(results[0]).toEqual(results[1]); expect(run).toHaveBeenCalledOnce();
    expect(() => commands.dispatch({ ...request, transcript: 'Different task' })).toThrow('different request');
    expect(() => commands.dispatch({ ...request, selectedId: 'new-note' })).toThrow('different request');
  });
  it('remembers a blocking question so a short answer needs no repeated request', async () => {
    const { commands, run } = setup();
    run.mockResolvedValueOnce({ state: 'clarify', reply: 'Which project?' });
    await commands.dispatch(request);
    await commands.dispatch({ ...request, transcript: '/projects/demo', requestId: 'request-124' });
    const next = run.mock.calls[1][0];
    expect(next.transcript).toBe('/projects/demo');
    expect(next.history[0].content).toBe(request.transcript);
    expect(next.history[1].content).toContain('Which project?');
  });
  it('serializes follow-ups in one conversation without mixing another conversation', async () => {
    const { commands, run } = setup();
    let finish;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = commands.dispatch(request);
    const two = commands.dispatch({ ...request, requestId: 'request-124', transcript: 'Use Markdown.' });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    finish(result); await Promise.all([one, two]);
    expect(run.mock.calls[1][0].history).toHaveLength(2);
    await commands.dispatch({ ...request, requestId: 'request-125', conversationId: 'different-chat' });
    expect(run.mock.calls[2][0].history).toEqual([]);
  });
  it('allows a retry if no work was accepted', async () => {
    const { commands, run } = setup();
    run.mockRejectedValueOnce(new Error('All agents are busy.'));
    await expect(commands.dispatch(request)).rejects.toThrow('busy');
    expect((await commands.dispatch(request)).state).toBe('assigned'); expect(run).toHaveBeenCalledTimes(2);
  });
  it('keeps memory bounded and ignores background speech', async () => {
    const { commands, run } = setup();
    for (let i = 0; i < 8; i++) await commands.dispatch({ ...request, requestId: `request-${i}00` });
    expect(commands.conversations.get(request.conversationId).history).toHaveLength(6);
    run.mockResolvedValueOnce({ state: 'ignore', reply: '' });
    await commands.dispatch({ ...request, requestId: 'ignored-123' });
    expect(commands.conversations.get(request.conversationId).history).toHaveLength(6);
  });
  it('summarizes each completed voice result once and remembers the outcome', async () => {
    const { commands, summarize, record } = setup();
    await commands.dispatch(request);
    const payload = { id: record.id, conversationId: request.conversationId };
    const replies = await Promise.all([commands.summarize(payload), commands.summarize(payload)]);
    expect(replies[0]).toEqual(replies[1]); expect(summarize).toHaveBeenCalledOnce();
    expect(commands.conversations.get(request.conversationId).history.at(-1).content).toContain('demo.md');
    record.status = 'running'; expect(() => commands.summarize(payload)).toThrow('still running');
    record.source = 'text'; expect(() => commands.summarize(payload)).toThrow('not found');
  });
});

describe('idle agent reservation', () => {
  it('reserves distinct agents atomically across voice and direct requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-idle-'));
    const agents = ['codex', 'claude'].map(id => ({ id, kind: 'cli', path: `/bin/${id}`, available: true }));
    const children = [];
    const service = new TaskService({ root, agentDetector: async () => agents, spawnProcess: command => {
      const child = new EventEmitter(); child.agentId = path.basename(command); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); children.push(child); return child;
    } });
    try {
      const [one, two] = await Promise.all([service.start('codex', 'direct'), service.startIdle('voice')]);
      expect(new Set([one.agentId, two.agentId]).size).toBe(2);
      await expect(service.startIdle('third')).rejects.toMatchObject({ code: 'AGENT_BUSY' });
      expect(children).toHaveLength(2);
      children[0].emit('close', 0);
      const next = await service.startIdle('next');
      expect(next.agentId).toBe(children[0].agentId);
    } finally { children.forEach(c => c.emit('close', 0)); await rm(root, { recursive: true, force: true }); }
  });
  it('excludes desktop and unsupported launchers', async () => {
    const service = new TaskService({ agentDetector: async () => [{ id: 'cursor', kind: 'desktop' }, { id: 'codex', kind: 'desktop' }] });
    await expect(service.startIdle('task')).rejects.toMatchObject({ code: 'NO_AGENTS' });
  });
});
