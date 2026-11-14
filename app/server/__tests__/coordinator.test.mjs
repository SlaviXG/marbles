import { expect, it, vi } from 'vitest';
import { ClaudeCoordinator, buildVoicePrompt } from '../agents/ClaudeCoordinator.mjs';

const plan = { problem: 'No demo plan', objective: 'Write demo.md', summary: 'I’ll draft a one-page plan, then verify it.', plan: ['Draft a one-page plan', 'Check timing and next steps'], assumptions: ['Five-minute demo'], constraints: ['Use Markdown'], successCriteria: ['Includes a timed demo script'], collaboration: 'solo', agentId: 'auto' };
const tool = (name, input, id = 'tool-123') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const answer = text => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
function setup(...responses) {
  const fetchApi = vi.fn();
  responses.forEach(response => fetchApi.mockResolvedValueOnce({ ok: true, json: async () => response }));
  const task = { id: 'task-1234', agentId: 'codex', status: 'running', artifacts: [] };
  const taskService = { root: '/tmp/marbles-test', agentDetector: async () => [{ id: 'codex', kind: 'cli', available: true }], isBusy: () => false, snapshot: () => [], startIdle: vi.fn(async () => task), start: vi.fn(async () => task) };
  const coordinator = new ClaudeCoordinator({ taskService, apiKey: 'secret-key', fetchApi });
  return { coordinator, taskService, fetchApi, task };
}

it('uses Claude tools, delegates a concrete plan, and keeps spoken acknowledgements brief', async () => {
  const { coordinator, taskService, fetchApi } = setup(tool('delegate_work', plan), answer('I’ll draft and verify the plan. Codex is on it.'));
  const result = await coordinator.run({ transcript: 'Make a demo plan' });
  expect(result.state).toBe('assigned'); expect(result.intent.assumptions).toEqual(['Five-minute demo']);
  const [prompt, metadata] = taskService.startIdle.mock.calls[0];
  expect(prompt).toContain('Make a demo plan'); expect(prompt).toContain('Five-minute demo'); expect(prompt).toContain('Draft a one-page plan');
  expect(metadata).toMatchObject({ source: 'voice', title: 'Write demo.md' });
  const request = JSON.parse(fetchApi.mock.calls[0][1].body);
  expect(fetchApi.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  expect(fetchApi.mock.calls[0][1].headers['x-api-key']).toBe('secret-key');
  expect(request.tool_choice).toEqual({ type: 'auto' });
  expect(request.tools.map(tool => tool.name)).toContain('inspect_agent');
  expect(fetchApi).toHaveBeenCalledOnce();
  expect(result.reply.split(' ').length).toBeLessThanOrEqual(35);
});

it('inspects real context before giving an answer without launching a worker', async () => {
  const { coordinator, taskService, fetchApi } = setup(tool('inspect_context', {}), tool('respond', { decision: 'reply', reply: 'Codex is idle.' }));
  const result = await coordinator.run({ transcript: 'What is Codex doing?' });
  expect(result).toEqual({ state: 'reply', reply: 'Codex is idle.' });
  expect(taskService.startIdle).not.toHaveBeenCalled();
  const second = JSON.parse(fetchApi.mock.calls[1][1].body);
  expect(second.messages.at(-1).content[0].content).toContain('codex');
});

it('asks one blocking question without delegating', async () => {
  const { coordinator, taskService } = setup(tool('respond', { decision: 'clarify', reply: 'Which repository should I change?' }));
  expect((await coordinator.run({ transcript: 'Fix that app', history: [] })).state).toBe('clarify');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});

it('requires inspection results before acting on a plan proposed in the same batch', async () => {
  const batch = tool('inspect_context', {});
  batch.content.push({ type: 'tool_use', id: 'premature-plan', name: 'delegate_work', input: plan });
  const { coordinator, taskService, fetchApi } = setup(batch, tool('delegate_work', plan));
  expect((await coordinator.run({ transcript: 'Make a demo plan' })).state).toBe('assigned');
  expect(taskService.startIdle).toHaveBeenCalledOnce();
  const second = JSON.parse(fetchApi.mock.calls[1][1].body);
  expect(second.messages.at(-1).content.find(item => item.tool_use_id === 'premature-plan').is_error).toBe(true);
});

it('ends on the actual receipt without a second provider request after work is accepted', async () => {
  const { coordinator, taskService, fetchApi } = setup(tool('delegate_work', plan));
  fetchApi.mockResolvedValueOnce({ ok: false, status: 503 });
  const result = await coordinator.run({ transcript: 'Make a demo plan' });
  expect(result.state).toBe('assigned'); expect(result.task.id).toBe('task-1234');
  expect(result.reply).toContain('codex is on it'); expect(taskService.startIdle).toHaveBeenCalledOnce(); expect(fetchApi).toHaveBeenCalledOnce();
});

it('uses another idle agent if the preferred one became busy', async () => {
  const { coordinator, taskService } = setup(tool('delegate_work', { ...plan, agentId: 'codex' }), answer('Another idle worker is on it.'));
  taskService.start.mockRejectedValueOnce(Object.assign(new Error('Agent is busy'), { code: 'AGENT_BUSY' }));
  await coordinator.run({ transcript: 'Make a demo plan' });
  expect(taskService.startIdle).toHaveBeenCalledOnce();
});

it('uses the existing swarm runner for collaborative plans and keeps voice provenance', async () => {
  const { coordinator, taskService } = setup(tool('delegate_work', { ...plan, collaboration: 'swarm' }), answer('Codex and Claude are preparing the demo together.'));
  const swarm = { id: 'swarm-123', agents: ['codex', 'claude'], status: 'running' };
  coordinator.swarmService = { start: vi.fn(async () => swarm) };
  const result = await coordinator.run({ transcript: 'Have the agents work together on a demo plan' });
  expect(result.state).toBe('swarm'); expect(swarm.source).toBe('voice');
  expect(coordinator.swarmService.start.mock.calls[0][0].goal.length).toBeLessThanOrEqual(6000);
  expect(taskService.startIdle).not.toHaveBeenCalled();
});

it.each(['max_tokens', 'refusal'])('does not act on an unfinished %s response', async stop_reason => {
  const { coordinator, taskService } = setup({ ...tool('delegate_work', plan), stop_reason });
  await expect(coordinator.run({ transcript: 'Make a plan' })).rejects.toThrow('did not finish');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});

it('validates an entire batch before launching any work', async () => {
  const response = tool('delegate_work', plan);
  response.content.push({ type: 'tool_use', id: 'second-tool', name: 'delegate_work', input: plan });
  const { coordinator, taskService } = setup(response);
  await expect(coordinator.run({ transcript: 'Make a plan' })).rejects.toThrow('single executable action');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});

it('keeps inspection failures in the loop so Claude can recover', async () => {
  const { coordinator, fetchApi } = setup(tool('read_asset', { path: '../secret' }), tool('respond', { decision: 'reply', reply: 'That file is outside the task workspace.' }));
  const result = await coordinator.run({ transcript: 'Read a file' });
  expect(result.state).toBe('reply');
  expect(JSON.parse(fetchApi.mock.calls[1][1].body).messages.at(-1).content[0].is_error).toBe(true);
});

it('bounds memory excerpts in worker prompts while preserving the exact current request', () => {
  const request = 'Create a demo plan';
  const prompt = buildVoicePrompt(request, plan, { selected: 'x'.repeat(20000) }, [{ role: 'user', content: 'y'.repeat(20000) }]);
  expect(prompt).toContain(request); expect(prompt.length).toBeLessThanOrEqual(10000);
});

it('summarizes outcomes without reading raw logs aloud and falls back on provider failure', async () => {
  const { coordinator, fetchApi } = setup(answer('The demo plan is ready in demo.md.'));
  const record = { status: 'completed', title: 'Demo plan', artifacts: [{ name: 'demo.md' }], stdout: 'verbose log '.repeat(1000) };
  expect(await coordinator.summarize(record)).toBe('The demo plan is ready in demo.md.');
  expect(JSON.parse(fetchApi.mock.calls[0][1].body).messages[0].content.length).toBeLessThan(4500);
  fetchApi.mockResolvedValueOnce({ ok: false, status: 500 });
  const fallback = await coordinator.summarize({ ...record, status: 'failed' });
  expect(fallback).toContain('Couldn’t finish'); expect(fallback).not.toContain('verbose log');
});

it('reports missing configuration without making a provider request', async () => {
  const { coordinator, fetchApi } = setup(); coordinator.apiKey = '';
  await expect(coordinator.run({ transcript: 'Make a plan' })).rejects.toMatchObject({ code: 'COORDINATOR_CONFIG' });
  expect(fetchApi).not.toHaveBeenCalled();
});

it('removes execution tools for a status/log request and refuses an unexpected mutation', async () => {
  const { coordinator, fetchApi, taskService } = setup(tool('delegate_work', plan));
  await expect(coordinator.run({ transcript: 'What is Codex doing?', readOnly: true })).rejects.toThrow('Unsupported coordinator tool');
  const tools = JSON.parse(fetchApi.mock.calls[0][1].body).tools.map(tool => tool.name);
  expect(tools).not.toContain('delegate_work'); expect(tools).not.toContain('cancel_work');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});
