import { expect, it, vi } from 'vitest';
import { HermesCoordinator, buildVoicePrompt } from '../agents/HermesCoordinator.mjs';
const plan = { problem: 'No demo plan', objective: 'Write demo.md', summary: 'I’ll draft a one-page plan, then verify it.', plan: ['Draft a one-page plan', 'Check timing and next steps'], assumptions: ['Five-minute demo'], constraints: ['Use Markdown'], successCriteria: ['Includes a timed demo script'], collaboration: 'solo', agentId: 'auto' };
const runtime = { runtime: 'Hermes', module: 'run_agent', model: 'claude-sonnet-5-5' };
function setup(behavior) {
  const task = { id: 'task-1234', agentId: 'codex', status: 'running', artifacts: [] };
  const taskService = { root: '/tmp/marbles-test', agentDetector: async () => [{ id: 'codex', kind: 'cli', available: true }], isBusy: () => false, snapshot: () => [], startIdle: vi.fn(async () => task), start: vi.fn(async () => task) };
  const runner = vi.fn(behavior ?? (async (_payload, call) => { await call('delegate_work', plan); return { completed: false, interrupted: true, runtime }; }));
  const coordinator = new HermesCoordinator({ taskService, apiKey: 'secret-key', runner });
  return { coordinator, taskService, runner, task };
}
it('hands reasoning and the tool loop to Hermes, then acknowledges a validated actual assignment', async () => {
  const { coordinator, taskService, runner } = setup();
  const result = await coordinator.run({ transcript: 'Make a demo plan' });
  expect(result.state).toBe('assigned'); expect(result.runtime).toEqual(runtime);
  expect(result.intent.assumptions).toEqual(['Five-minute demo']);
  const [prompt, metadata] = taskService.startIdle.mock.calls[0];
  expect(prompt).toContain('Make a demo plan'); expect(prompt).toContain('Five-minute demo');
  expect(metadata).toMatchObject({ source: 'voice', title: 'Write demo.md', routing: { reason: expect.stringContaining('Hermes plan') } });
  expect(runner.mock.calls[0][0].tools.map(tool => tool.name)).toContain('inspect_agent');
  expect(runner.mock.calls[0][0].model).toBe('claude-opus-5-5');
  expect(runner.mock.calls[0][0].effort).toBe('medium');
  expect(result.reply.split(' ').length).toBeLessThanOrEqual(25);
});
it('lets Hermes inspect context and answer without starting a worker', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => {
    expect((await call('inspect_context', {})).result).toContain('codex');
    await call('respond', { decision: 'reply', reply: 'Codex is idle.' });
    return { interrupted: true, runtime };
  });
  expect((await coordinator.run({ transcript: 'What is Codex doing?' })).reply).toBe('Codex is idle.');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});
it('lets Hermes close the separate YouTube window directly without launching a worker', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => {
    const receipt = await call('close_window', { target: 'video', reply: 'Video closed.' });
    expect(receipt.terminal).toBe(true); return { interrupted: true, runtime };
  });
  expect(await coordinator.run({ transcript: 'Could you close that YouTube window?' })).toMatchObject({ state: 'show', display: { kind: 'close', target: 'video' } });
  expect(taskService.startIdle).not.toHaveBeenCalled();
});
it('supports one blocking question without delegating', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => {
    await call('respond', { decision: 'clarify', reply: 'Which repository should I change?' }); return { runtime };
  });
  expect((await coordinator.run({ transcript: 'Fix that app' })).state).toBe('clarify');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});
it('preserves accepted work if the Hermes process fails afterwards', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => { await call('delegate_work', plan); throw new Error('runtime stopped'); });
  expect((await coordinator.run({ transcript: 'Make a demo plan' })).task.id).toBe('task-1234');
  expect(taskService.startIdle).toHaveBeenCalledOnce();
});
it('prevents parallel Hermes callbacks from launching duplicate work', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => {
    await Promise.all([call('delegate_work', plan), call('delegate_work', plan)]); return { runtime };
  });
  await coordinator.run({ transcript: 'Make a demo plan' }); expect(taskService.startIdle).toHaveBeenCalledOnce();
});
it('waits for an in-flight app acceptance when the Hermes process times out', async () => {
  const { coordinator, taskService, task } = setup(async (_payload, call) => { void call('delegate_work', plan); throw new Error('runtime timeout'); });
  let accept;
  taskService.startIdle.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  const pending = coordinator.run({ transcript: 'Make a plan' });
  await vi.waitFor(() => expect(taskService.startIdle).toHaveBeenCalledOnce());
  accept(task);
  expect((await pending).task.id).toBe(task.id);
  expect(taskService.startIdle).toHaveBeenCalledOnce();
});
it('falls back to an idle worker if the preferred agent becomes busy', async () => {
  const { coordinator, taskService } = setup(async (_payload, call) => { await call('delegate_work', { ...plan, agentId: 'codex' }); return { runtime }; });
  taskService.start.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'AGENT_BUSY' }));
  await coordinator.run({ transcript: 'Make a plan' }); expect(taskService.startIdle).toHaveBeenCalledOnce();
});
it('uses the existing swarm service and preserves voice provenance', async () => {
  const { coordinator, taskService } = setup();
  const swarm = { id: 'swarm-123', agents: ['codex', 'claude'], status: 'running' };
  coordinator.swarmService = { start: vi.fn(async () => swarm) };
  expect((await coordinator.run({ transcript: 'Have all agents work together on the demo' })).state).toBe('swarm');
  expect(swarm.source).toBe('voice'); expect(taskService.startIdle).not.toHaveBeenCalled();
});
it('excludes execution tools for read-only questions and rejects an unexpected mutation', async () => {
  const { coordinator, runner, taskService } = setup();
  await expect(coordinator.run({ transcript: 'What is Codex doing?', readOnly: true })).rejects.toThrow('Unsupported coordinator tool');
  expect(runner.mock.calls[0][0].tools.map(tool => tool.name)).not.toContain('delegate_work');
  expect(taskService.startIdle).not.toHaveBeenCalled();
});
it('accepts a native Hermes final answer and rejects an incomplete turn', async () => {
  const { coordinator, runner } = setup(async () => ({ completed: true, reply: 'Ready.', runtime }));
  expect((await coordinator.run({ transcript: 'Hello' })).reply).toBe('Ready.');
  runner.mockResolvedValueOnce({ completed: false, reply: 'partial', runtime });
  await expect(coordinator.run({ transcript: 'Hello' })).rejects.toThrow('did not finish');
});
it('bounds context excerpts while preserving the exact current request', () => {
  const prompt = buildVoicePrompt('Make a plan', plan, { selected: 'x'.repeat(20000) }, [{ role: 'user', content: 'y'.repeat(20000) }]);
  expect(prompt).toContain('Make a plan'); expect(prompt.length).toBeLessThanOrEqual(10000);
});
it('uses Hermes for concise result summaries with no execution tools, and has a local fallback', async () => {
  const { coordinator, runner } = setup(async () => ({ completed: true, reply: 'The demo plan is ready in demo.md.', runtime }));
  const record = { status: 'completed', title: 'Demo plan', artifacts: [{ name: 'demo.md' }], stdout: 'logs '.repeat(1000) };
  expect(await coordinator.summarize(record)).toBe('The demo plan is ready in demo.md.');
  expect(runner.mock.calls[0][0].tools).toEqual([]);
  runner.mockRejectedValueOnce(new Error('offline'));
  expect(await coordinator.summarize({ ...record, status: 'failed' })).toContain('Couldn’t finish');
});
