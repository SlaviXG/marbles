import { beforeEach, describe, expect, it } from 'vitest';
import { CompletionTracker, artifactSelection, resolvePresentation, taskPresentation, swarmPresentation } from '../core/presentation';
import { usePresentation } from '../state/presentation';
import type { AgentTask, SwarmTask } from '../core/agentTypes';

const file = { name: 'report.pdf', path: 'codex/t1/report.pdf', type: 'pdf' as const };
const task: AgentTask = { id: 't1', agentId: 'codex', prompt: 'Write report', status: 'running', createdAt: '', updatedAt: '', stdout: '', stderr: '', artifacts: [file] };
const swarm: SwarmTask = { id: 's1', goal: 'Research together', mode: 'swarm', agents: ['claude', 'codex'], winnerId: 'codex', status: 'running', createdAt: '', endedAt: null, runs: [], blackboard: [], artifacts: [file], reward: null, success: null, tokenProxy: 0, contributions: {}, rationale: '', lesson: '' };

describe('completion presentations', () => {
  it('does not replay old completed work on the initial snapshot', () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe('task', [{ ...task, status: 'completed' }])).toEqual([]);
    expect(tracker.observe('task', [{ ...task, status: 'completed' }])).toEqual([]);
  });
  it('presents a live completion once despite repeated polling', () => {
    const tracker = new CompletionTracker();
    tracker.observe('task', [task]);
    expect(tracker.observe('task', [{ ...task, status: 'completed' }])).toHaveLength(1);
    expect(tracker.observe('task', [{ ...task, status: 'completed' }])).toEqual([]);
  });
  it('waits for asynchronously discovered files after completion', () => {
    const tracker = new CompletionTracker();
    tracker.observe('task', [{ ...task, artifacts: [] }]);
    expect(tracker.observe('task', [{ ...task, status: 'completed', artifacts: [] }])).toEqual([]);
    expect(tracker.observe('task', [{ ...task, status: 'completed' }])[0].artifacts).toEqual([file]);
  });
  it('captures fast tasks that finish between polls, without presenting failures', () => {
    const tracker = new CompletionTracker();
    tracker.observe('task', []);
    expect(tracker.observe('task', [{ ...task, status: 'failed' }])).toEqual([]);
    expect(tracker.observe('task', [{ ...task, id: 'fast', status: 'completed' }])).toHaveLength(1);
  });
  it('uses a swarm lead for shared deliverables and supports reopening files', () => {
    const tracker = new CompletionTracker();
    tracker.observe('swarm', [swarm]);
    const [item] = tracker.observe('swarm', [{ ...swarm, status: 'completed' }]);
    expect(item.leadAgentId).toBe('codex');
    expect(resolvePresentation(artifactSelection(item), [], [swarm])).toMatchObject({ index: 0, item: { key: 'swarm:s1' } });
    expect(resolvePresentation('artifact:missing:nope', [task], [])).toBeNull();
  });
});

describe('presentation lifecycle', () => {
  beforeEach(() => usePresentation.setState({ active: null, index: 0, phase: 'idle', queue: [], phaseAt: 0 }));
  it('queues simultaneous results without replacing the current presenter', () => {
    const first = taskPresentation(task), next = swarmPresentation(swarm);
    const state = usePresentation.getState();
    state.enqueue([first, first, next]);
    expect(usePresentation.getState().queue).toHaveLength(2);
    state.begin(first); state.show(); state.begin(next);
    expect(usePresentation.getState()).toMatchObject({ active: first, phase: 'presenting', queue: [next] });
  });
  it('keeps the presenter while folding and only releases it after returning home', () => {
    const state = usePresentation.getState();
    const item = taskPresentation(task);
    state.begin(item); state.show(); state.dismiss(); state.dismiss();
    expect(usePresentation.getState()).toMatchObject({ active: item, phase: 'returning' });
    state.show();
    expect(usePresentation.getState().phase).toBe('returning');
    state.finishReturn();
    expect(usePresentation.getState()).toMatchObject({ active: null, phase: 'idle' });
    expect(item.artifacts).toEqual([file]);
  });
  it('bounds file navigation and leaves the lifecycle intact when new files arrive', () => {
    const state = usePresentation.getState(); const item = taskPresentation(task);
    state.begin(item); state.show(); state.choose(100);
    expect(usePresentation.getState().index).toBe(0);
    state.refresh({ ...item, artifacts: [file, { ...file, name: 'chart.svg', path: 'chart.svg', type: 'image' }] });
    state.choose(1);
    expect(usePresentation.getState()).toMatchObject({ index: 1, phase: 'presenting' });
  });
});
