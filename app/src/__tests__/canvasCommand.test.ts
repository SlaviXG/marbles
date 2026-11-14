import { describe, expect, it } from 'vitest';
import { canvasCommand } from '../voice/canvasCommand';
import type { AgentTask } from '../core/agentTypes';
const task: AgentTask = { id: 't1', agentId: 'codex', prompt: 'Make report', status: 'completed', createdAt: '', updatedAt: '', stdout: '', stderr: '', artifacts: [{ name: 'report.pdf', path: 'codex/t1/report.pdf', type: 'pdf' }] };
describe('spoken canvas commands', () => {
  it('opens a known file without a new task, regardless of filename case', () => {
    expect(canvasCommand('show me REPORT.PDF', [task])?.select).toBe('artifact:t1:codex%2Ft1%2Freport.pdf');
  });
  it('does not guess between identically named files', () => {
    expect(canvasCommand('open report.pdf', [task, { ...task, id: 't2' }])?.select).toBeUndefined();
  });
  it('leaves new work and unknown targets to the task interpreter', () => {
    expect(canvasCommand('create report.pdf', [task])).toBeNull();
    expect(canvasCommand('open my project folder', [task])).toBeNull();
    expect(canvasCommand('close my bank account', [task])).toBeNull();
  });
  it('recognizes explicit preview dismissal', () => {
    expect(canvasCommand('close the preview', [task])?.close).toBe(true);
  });
});
