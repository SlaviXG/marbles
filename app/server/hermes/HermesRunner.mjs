import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from '../agents/logs.mjs';

const root = fileURLToPath(new URL('../../.hermes-runtime/', import.meta.url));
const bridge = fileURLToPath(new URL('./bridge.py', import.meta.url));
const protocol = 'marbles-hermes-v1';
const configError = message => Object.assign(new Error(message), { code: 'COORDINATOR_CONFIG' });

export async function runHermes(payload, onTool, { apiKey = process.env.ANTHROPIC_API_KEY, spawnProcess = spawn, runtimeRoot = root, timeoutMs = 50_000 } = {}) {
  if (!apiKey) throw configError('Add ANTHROPIC_API_KEY to the repo-root .env and restart the app server.');
  const python = path.join(runtimeRoot, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  try { await access(python); }
  catch { throw configError('Hermes is not installed. Run npm run setup:hermes in app, then restart the server.'); }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(python, ['-u', bridge], { shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ANTHROPIC_API_KEY: apiKey, HERMES_HOME: path.join(runtimeRoot, 'home'),
        PYTHONPATH: path.join(runtimeRoot, 'source'), PYTHONUNBUFFERED: '1' } });
    let settled = false, calls = 0, ready;
    let bufferBytes = 0;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); lines.close(); child.stdin.end(); child.kill('SIGTERM');
      if (error) reject(error); else resolve({ ...result, runtime: ready });
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Hermes coordinator timed out. Please retry.'), { code: 'COORDINATOR_UNAVAILABLE' })), timeoutMs);
    const lines = createInterface({ input: child.stdout });
    child.stdout.on('data', chunk => { bufferBytes += chunk.length; if (bufferBytes > 1024 * 1024) finish(new Error('Hermes output exceeded the coordination limit.')); });
    // Drain upstream logs without forwarding potentially sensitive provider data.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(configError('Could not start Hermes. Run npm run setup:hermes.')));
    child.on('close', () => { if (!settled) finish(new Error('Hermes stopped before returning a result. Check its runtime installation.')); });
    child.stdin.on('error', () => {});
    lines.on('line', async line => {
      if (settled) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.protocol !== protocol) return;
      if (event.type === 'ready') { ready = event; return; }
      if (event.type === 'error') return finish(Object.assign(new Error(event.message), { code: 'COORDINATOR_UNAVAILABLE' }));
      if (event.type === 'result') return finish(null, event);
      if (event.type !== 'tool') return;
      if (++calls > 12 || typeof event.id !== 'string' || event.id.length > 100) return finish(new Error('Hermes reached its tool-call limit.'));
      let response;
      try { response = await onTool(event.name, event.input); }
      catch (error) { response = { error: redactSecrets(error.message).slice(0, 300) }; }
      if (!settled) child.stdin.write(JSON.stringify({ id: event.id, ...response }) + '\n');
    });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}
