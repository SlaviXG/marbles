import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoordinatorTools } from '../agents/CoordinatorTools.mjs';

it('reads generated text, redacts credentials, and blocks traversal, hidden files, and outside symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'marbles-coordinator-assets-'));
  try {
    await mkdir(path.join(root, 'task'));
    await writeFile(path.join(root, 'task', 'report.csv'), 'name,value\nsecret,sk-ant-abcdefghijklmno\n');
    await writeFile(path.join(root, 'task', '.env'), 'PRIVATE=secret');
    await writeFile(path.join(root, 'task', 'report.pdf'), 'binary');
    await symlink('/etc/passwd', path.join(root, 'task', 'outside.txt'));
    const tools = new CoordinatorTools({ taskService: { root } });
    const data = await tools.call('read_asset', { path: 'task/report.csv' });
    expect(data.text).toContain('[redacted]'); expect(data.text).not.toContain('sk-ant-');
    expect(data.absolutePath).toBe(await realpath(path.join(root, 'task', 'report.csv')));
    expect((await tools.call('read_asset', { path: 'task/report.pdf' })).note).toContain('Binary');
    await expect(tools.call('read_asset', { path: '../escape' })).rejects.toThrow();
    await expect(tools.call('read_asset', { path: 'task/.env' })).rejects.toThrow();
    await expect(tools.call('read_asset', { path: 'task/outside.txt' })).rejects.toThrow();
    const found = await tools.call('find_assets', { query: 'report' });
    expect(found.files.map(file => file.name).sort()).toEqual(['report.csv', 'report.pdf']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('checks any discovered agent and distinguishes its managed work from the latest session log', async () => {
  const readAgentLog = vi.fn(async () => ({ available: true, messages: [{ text: 'Latest session output' }] }));
  const record = { id: 'task-123', agentId: 'codex', status: 'running', title: 'Demo', stdout: 'Working', artifacts: [] };
  const tools = new CoordinatorTools({ taskService: { agentDetector: async () => [{ id: 'codex', kind: 'cli' }], snapshot: () => [record], isBusy: () => true }, readAgentLog });
  const result = await tools.call('inspect_agent', { agentId: 'codex' });
  expect(result.managedBusy).toBe(true); expect(result.managedTasks[0].output).toBe('Working');
  expect(result.latestSession.messages[0].text).toBe('Latest session output');
  await expect(tools.call('inspect_agent', { agentId: 'invented' })).rejects.toThrow('not found');
});

it('searches and reads registered notes without accepting arbitrary filesystem paths', async () => {
  const note = { id: 'demo', title: 'Demo script', path: '/vault/demo.md', sections: [{ content: 'Show the spreadsheet and the voice interface.' }] };
  const tools = new CoordinatorTools({ taskService: {}, noteProvider: () => [note] });
  expect((await tools.call('search_notes', { query: 'spreadsheet' }))[0].id).toBe('demo');
  expect((await tools.call('read_note', { id: 'demo' })).text).toContain('voice interface');
  await expect(tools.call('read_note', { id: '/etc/passwd' })).rejects.toThrow('not found');
});

it('inspects and cancels only known managed work', async () => {
  const record = { id: 'task-123', status: 'running', artifacts: [], stdout: 'Doing work' };
  const cancel = vi.fn(() => ({ ...record, status: 'cancelling' }));
  const tools = new CoordinatorTools({ taskService: { snapshot: () => [record], cancel } });
  expect((await tools.call('inspect_work', { id: record.id, kind: 'task' })).output).toBe('Doing work');
  expect((await tools.call('cancel_work', { id: record.id, kind: 'task' })).status).toBe('cancelling');
  expect(cancel).toHaveBeenCalledOnce();
  await expect(tools.call('cancel_work', { id: 'not-managed', kind: 'task' })).rejects.toThrow('not found');
  expect(cancel).toHaveBeenCalledOnce();
});
