import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runHermes } from '../hermes/HermesRunner.mjs';

const roots = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function runtime() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-hermes-runner-')); roots.push(root);
  const python = path.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await mkdir(path.dirname(python), { recursive: true }); await writeFile(python, 'mock executable'); return root;
}
function childProcess(onInput) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn();
  child.stdin = new Writable({ write(chunk, _encoding, done) { onInput(JSON.parse(chunk.toString()), child); done(); } });
  child.emitProtocol = event => child.stdout.write(JSON.stringify({ protocol: 'marbles-hermes-v1', ...event }) + '\n');
  return child;
}
it('uses a Python subprocess and keeps the key in its environment, not arguments or payload', async () => {
  const runtimeRoot = await runtime(); const payload = { query: 'Make a plan', tools: [] }; let child;
  const spawnProcess = vi.fn(() => (child = childProcess((_input, process) => {
    process.stdout.write('upstream startup noise\n');
    process.emitProtocol({ type: 'ready', runtime: 'Hermes', module: 'run_agent' });
    process.emitProtocol({ type: 'result', completed: true, reply: 'Ready.', apiCalls: 1 });
  })));
  const result = await runHermes(payload, vi.fn(), { runtimeRoot, spawnProcess, apiKey: 'secret-key' });
  expect(result.runtime.module).toBe('run_agent'); expect(result.reply).toBe('Ready.');
  const [python, args, options] = spawnProcess.mock.calls[0];
  expect(python).toContain('venv'); expect(args.join(' ')).toContain('bridge.py');
  expect(JSON.stringify(args)).not.toContain('secret-key'); expect(JSON.stringify(payload)).not.toContain('secret-key');
  expect(options.env.ANTHROPIC_API_KEY).toBe('secret-key'); expect(options.env.HERMES_HOME).toContain(runtimeRoot);
  expect(options.shell).toBe(false); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
});
it('routes only protocol tool events to the host and forwards terminal receipts to Hermes', async () => {
  const runtimeRoot = await runtime(); const onTool = vi.fn(async () => ({ result: { state: 'assigned' }, terminal: true }));
  let receipt;
  const spawnProcess = () => childProcess((input, process) => {
    if (input.query) {
      process.stdout.write(JSON.stringify({ type: 'tool', name: 'not-protocol' }) + '\n');
      process.emitProtocol({ type: 'tool', id: 'tool-123', name: 'delegate_work', input: { objective: 'Make a plan' } });
    } else { receipt = input; process.emitProtocol({ type: 'result', interrupted: true, completed: false }); }
  });
  await runHermes({ query: 'Plan' }, onTool, { runtimeRoot, spawnProcess, apiKey: 'test' });
  expect(onTool).toHaveBeenCalledOnce(); expect(onTool).toHaveBeenCalledWith('delegate_work', { objective: 'Make a plan' });
  expect(receipt).toEqual({ id: 'tool-123', result: { state: 'assigned' }, terminal: true });
});
it('returns host tool errors to Hermes without exposing credentials', async () => {
  const runtimeRoot = await runtime(); let receipt;
  const spawnProcess = () => childProcess((input, process) => {
    if (input.query) process.emitProtocol({ type: 'tool', id: 'tool-123', name: 'read_asset', input: {} });
    else { receipt = input; process.emitProtocol({ type: 'result', completed: true, reply: 'Unavailable.' }); }
  });
  await runHermes({ query: 'Read' }, async () => { throw new Error('token=private'); }, { runtimeRoot, spawnProcess, apiKey: 'test' });
  expect(receipt.error).toContain('[redacted]'); expect(receipt.error).not.toContain('private');
});
it('fails cleanly when Hermes closes without a result', async () => {
  const runtimeRoot = await runtime();
  const spawnProcess = () => childProcess((_input, process) => queueMicrotask(() => process.emit('close', 1)));
  await expect(runHermes({ query: 'Hello' }, vi.fn(), { runtimeRoot, spawnProcess, apiKey: 'test' })).rejects.toThrow('stopped before');
});
it('does not start a process without a Claude key', async () => {
  const spawnProcess = vi.fn();
  await expect(runHermes({}, vi.fn(), { apiKey: '', spawnProcess })).rejects.toMatchObject({ code: 'COORDINATOR_CONFIG' });
  expect(spawnProcess).not.toHaveBeenCalled();
});
