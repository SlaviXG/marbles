import { describe, it, expect, vi } from 'vitest';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcher, validateArtifactPath, resolveArtifact, TaskService, scanArtifacts } from '../agents/taskService.mjs';
import { parseLog, parseCursorStream, agentLog } from '../agents/logs.mjs';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const codex = { id: 'codex', kind: 'cli', path: '/bin/codex' };
const claude = { id: 'claude', kind: 'cli', path: '/bin/claude' };
describe('task launcher', () => {
  it('keeps a cancelling agent busy until its managed process exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-cancel-'));
    const child = new EventEmitter(); child.kill = vi.fn(() => true);
    const service = new TaskService({ root, agentDetector: async () => [codex], spawnProcess: () => child });
    try {
      const task = await service.start('codex', 'Do work');
      expect(service.cancel(task.id).status).toBe('cancelling');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(service.isBusy('codex')).toBe(true);
      child.emit('close', null);
      expect(task.status).toBe('cancelled'); expect(service.isBusy('codex')).toBe(false);
      expect(service.cancel('unknown')).toBe(null);
    } finally { child.emit('close', null); await rm(root, { recursive: true, force: true }); }
  });
  it('keeps dependency files from crowding real deliverables out of artifact discovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-files-'));
    try {
      await mkdir(path.join(root, 'node_modules', 'library'), { recursive: true });
      await writeFile(path.join(root, 'node_modules', 'library', 'README.md'), 'dependency');
      await writeFile(path.join(root, 'report.md'), 'deliverable');
      expect((await scanArtifacts(root, root)).map(file => file.name)).toEqual(['report.md']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('starts empty and only reports files from a newly instructed task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-task-'));
    const previous = path.join(root, 'codex', 'previous');
    const spawnProcess = vi.fn(() => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; });
    try {
      await mkdir(previous, { recursive: true });
      await writeFile(path.join(previous, 'old.md'), 'old run');
      const service = new TaskService({ agentDetector: async () => [codex], root, spawnProcess });
      expect(service.snapshot()).toEqual([]);
      const task = await service.start('codex', 'write a file');
      expect(task.artifacts).toEqual([]);
      const generated = path.join(root, 'codex', task.id, 'new.md');
      await writeFile(generated, 'new run');
      spawnProcess.mock.results[0].value.stdout.emit('data', 'done');
      await vi.waitFor(() => expect(task.artifacts.map(a => a.name)).toEqual(['new.md']));
      spawnProcess.mock.results[0].value.emit('close', 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('builds verified argv and spawns without a shell', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-task-'));
    const calls = [];
    const spawnProcess = vi.fn((...args) => { calls.push(args); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; });
    try {
      const service = new TaskService({ agentDetector: async () => [codex], root, spawnProcess });
      const task = await service.start('codex', 'do X');
      expect(task.status).toBe('running');
      expect(calls[0][0]).toBe('/bin/codex');
      expect(calls[0][1]).toEqual(['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-C', path.join(root, 'codex', task.id), 'do X']);
      expect(calls[0][2].shell).toBe(false);
      calls.length = 0;
      expect(launcher(claude, 'do Y', root).args).toEqual(['-p', 'do Y', '--permission-mode', 'acceptEdits']);
      expect(launcher({ id: 'cursor', kind: 'cli', path: '/bin/agent' }, 'do Z', root)).toEqual({ command: '/bin/agent', args: ['-p', '--force', '--trust', '--output-format', 'stream-json', '--workspace', root, 'do Z'], options: { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } });
      spawnProcess.mock.results[0].value.emit('close', 0);
      expect(task.status).toBe('completed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe('artifact path safety', () => {
  it('rejects traversal and symlinks outside the root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-artifact-'));
    try {
      expect(() => validateArtifactPath(root, '../escape')).toThrow();
      expect(() => validateArtifactPath(root, '/etc/passwd')).toThrow();
      expect(() => validateArtifactPath(root, 'x/../../escape')).toThrow();
      const { symlink } = await import('node:fs/promises');
      await symlink('/etc/passwd', path.join(root, 'link'));
      await expect(resolveArtifact(root, 'link')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
describe('log parsing', () => {
  it('parses Cursor stream output, redacts secrets, and handles missing output', async () => {
    const stdout = [
      { type: 'system' },
      { type: 'user', message: { content: [{ type: 'text', text: 'Please inspect report' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'I found sk-abcdefghijklmnop' }] } },
      { type: 'tool_call', subtype: 'started', tool_call: { name: 'ReadFile', input: { password: 'private' } } },
      { type: 'result', result: 'Done' },
    ].map(JSON.stringify).join('\n');
    const log = parseCursorStream(stdout.split('\n'));
    expect(log.prompt.text).toContain('report');
    expect(log.messages.at(-1).text).toBe('Done');
    expect(log.tools[0].name).toBe('ReadFile');
    expect(JSON.stringify(log)).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(log)).not.toContain('private');
    expect(await agentLog('cursor', undefined, '')).toMatchObject({ available: false });
  });
  for (const kind of ['claude', 'codex']) it(`reads ${kind} fixture without exposing tool values`, async () => {
    const lines = (await readFile(path.join(fixtures, `${kind}.jsonl`), 'utf8')).split('\n');
    const log = parseLog(lines, kind);
    expect(log.prompt.text).toContain(kind === 'claude' ? 'report' : 'chart');
    expect(log.messages).toHaveLength(1);
    expect(log.tools).toHaveLength(1);
    expect(JSON.stringify(log.tools)).not.toContain('private');
    expect(JSON.stringify(log.tools)).not.toContain('echo secret');
  });
});
