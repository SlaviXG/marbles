import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VoiceCommands, interpretSpeech, buildVoicePrompt, classifyQuery } from '../agents/voiceCommands.mjs';
import { TaskService } from '../agents/taskService.mjs';

const intent = { decision: 'task', collaboration: 'solo', intent: 'task', targetAgents: [], problem: 'Missing greeting', objective: 'Write hello.txt', constraints: ['Use plain text'], successCriteria: ['Contains hello'], clarification: '' };
const request = { transcript: 'Please write hello.txt with hello.', requestId: 'request-123' };

describe('voice task understanding', () => {
  it('uses server-side structured output and preserves original wording', async () => {
    const fetchApi = vi.fn(async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(intent) }] }] }) }));
    expect(await interpretSpeech(request.transcript, { apiKey: 'secret', fetchApi })).toEqual(intent);
    const options = fetchApi.mock.calls[0][1];
    const payload = JSON.parse(options.body);
    expect(options.headers.Authorization).toBe('Bearer secret');
    expect(payload.text.format.strict).toBe(true);
    expect(payload.text.format.schema.properties.collaboration.enum).toEqual(['solo', 'swarm']);
    expect(payload.text.format.schema.properties.intent.enum).toEqual(['task', 'swarm', 'status', 'log']);
    expect(payload.text.format.schema.required).toContain('targetAgents');
    expect(payload.input).toBe(request.transcript);
    expect(payload.store).toBe(false);
    expect(buildVoicePrompt(request.transcript, intent)).toContain(request.transcript);
    expect(buildVoicePrompt(request.transcript, intent)).toContain('Missing greeting');
  });
  it.each(['incomplete', 'failed'])('does not execute an %s model result', async status => {
    await expect(interpretSpeech('task', { apiKey: 'test', fetchApi: async () => ({ ok: true, json: async () => ({ status }) }) })).rejects.toThrow('did not finish');
  });
  it('rejects malformed output and sanitizes provider failures', async () => {
    await expect(interpretSpeech('task', { apiKey: 'test', fetchApi: async () => ({ ok: false }) })).rejects.toThrow('OpenAI could not interpret');
    await expect(interpretSpeech('task', { apiKey: 'test', fetchApi: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [] }) }) })).rejects.toThrow('rephrase');
    await expect(interpretSpeech('task', { apiKey: 'test', fetchApi: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ ...intent, targetAgents: ['unknown'] }) }] }] }) }) })).rejects.toThrow('Invalid');
  });
  it('deduplicates simultaneous retries and records voice provenance', async () => {
    const startIdle = vi.fn(async () => ({ id: 'task-1' }));
    const interpret = vi.fn(async () => intent);
    const commands = new VoiceCommands({ taskService: { startIdle }, interpret });
    const results = await Promise.all([commands.dispatch(request), commands.dispatch(request)]);
    expect(results[0]).toEqual(results[1]);
    expect(interpret).toHaveBeenCalledOnce();
    expect(startIdle).toHaveBeenCalledOnce();
    expect(startIdle.mock.calls[0][1]).toMatchObject({ source: 'voice', transcript: request.transcript, title: intent.objective });
    expect(() => commands.dispatch({ ...request, transcript: 'different' })).toThrow('different transcript');
  });
  it.each(['ignore', 'clarify'])('does not launch for %s', async decision => {
    const startIdle = vi.fn();
    const commands = new VoiceCommands({ taskService: { startIdle }, interpret: async () => ({ ...intent, decision }) });
    expect((await commands.dispatch(request)).state).toBe(decision);
    expect(startIdle).not.toHaveBeenCalled();
  });
  it('allows retry after all agents were busy', async () => {
    const startIdle = vi.fn().mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'AGENT_BUSY' })).mockResolvedValue({ id: 'task' });
    const commands = new VoiceCommands({ taskService: { startIdle }, interpret: async () => intent });
    await expect(commands.dispatch(request)).rejects.toThrow('busy');
    expect((await commands.dispatch(request)).state).toBe('assigned');
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
