import { describe, expect, it } from 'vitest';
import { useAgents } from '../state/agents';

const codex = { id: 'codex', name: 'Codex', kind: 'cli' as const, command: 'codex', path: '/bin/codex', version: null, available: true, codingAgent: true };
const task = { id: 't1', agentId: 'codex', prompt: 'write', status: 'running' as const, createdAt: '', updatedAt: '', stdout: '', stderr: '', artifacts: [] };

describe('agent state', () => {
  it('keeps a removed agent unavailable while its task is visible, then restores it', () => {
    const state = useAgents.getState();
    state.setAgents([codex]);
    state.setTasks([task]);
    state.removeAgent('codex');
    expect(useAgents.getState().agents).toEqual([{ ...codex, available: false }]);
    expect(useAgents.getState().tasks).toEqual([task]);
    state.upsertAgent(codex);
    expect(useAgents.getState().agents).toEqual([codex]);
    state.setTasks([]);
    state.removeAgent('codex');
    expect(useAgents.getState().agents).toEqual([]);
  });
});
