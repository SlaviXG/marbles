import { describe, it, expect, vi } from 'vitest';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcher, validateArtifactPath, resolveArtifact, TaskService } from '../agents/taskService.mjs';
import { parseLog } from '../agents/logs.mjs';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const codex = { id: 'codex', kind: 'cli', path: '/bin/codex', instanceName: 'pushkar-codex' };
const claude = { id: 'claude', kind: 'cli', path: '/bin/claude', instanceName: 'pushkar-claude' };
describe('task launcher', () => {
  it('starts empty and only reports files from a newly instructed task', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-task-'));
    const previous = path.join(root, 'pushkar-codex', 'previous');
    const spawnProcess = vi.fn(() => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); return child; });
    try {
      await mkdir(previous, { recursive: true });
      await writeFile(path.join(previous, 'old.md'), 'old run');
      const service = new TaskService({ agentDetector: async () => [codex], root, spawnProcess });
      expect(service.snapshot()).toEqual([]);
      const task = await service.start('pushkar-codex', 'write a file');
      expect(task.artifacts).toEqual([]);
      const generated = path.join(root, 'pushkar-codex', task.id, 'new.md');
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
      const task = await service.start('pushkar-codex', 'do X');
      expect(task.status).toBe('running');
      expect(calls[0][0]).toBe('/bin/codex');
      expect(calls[0][1]).toEqual(['exec', '-s', 'workspace-write', '--skip-git-repo-check', '-C', path.join(root, 'pushkar-codex', task.id), 'do X']);
      expect(calls[0][2].shell).toBe(false);
      calls.length = 0;
      expect(launcher(claude, 'do Y', root).args).toEqual(['-p', 'do Y', '--permission-mode', 'acceptEdits']);
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
