import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(app, '.hermes-runtime');
const source = path.join(runtime, 'source');
const venv = path.join(runtime, 'venv');
const config = JSON.parse(await readFile(new URL('../server/hermes/runtime.json', import.meta.url), 'utf8'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: app, stdio: 'inherit', shell: false, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed. Install Git, uv and Python 3.14, then run npm run setup:hermes again.`);
}
await mkdir(runtime, { recursive: true });
let installed;
try { installed = JSON.parse(await readFile(path.join(runtime, 'manifest.json'), 'utf8')); } catch {}
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
let ready = installed?.revision === config.revision;
try { await access(python); } catch { ready = false; }
if (!ready) {
  let cloned = true;
  try { await access(path.join(source, '.git')); } catch { cloned = false; }
  if (!cloned) run('git', ['clone', '--depth', '1', '--filter=blob:none', '--sparse', '--no-checkout', config.repository, source]);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).stdout?.trim();
  if (head !== config.revision) {
    run('git', ['fetch', '--depth', '1', 'origin', config.revision], { cwd: source });
    run('git', ['checkout', '--detach', config.revision], { cwd: source });
  }
  run('git', ['sparse-checkout', 'set', ...config.directories], { cwd: source });
  try { await access(python); } catch { run('uv', ['venv', venv, '--python', '3.14']); }
  // Hermes requires its lockfile/overrides (plain pip resolution conflicts).
  run('uv', ['sync', '--frozen', '--project', source, '--extra', 'anthropic', '--no-dev'],
    { env: { ...process.env, UV_PROJECT_ENVIRONMENT: venv } });
}
await mkdir(path.join(runtime, 'home'), { recursive: true });
// This profile belongs only to Marbles. Its ten app tools stay directly visible
// instead of paying extra discovery turns through Hermes's tool-search layer.
await writeFile(path.join(runtime, 'home', 'config.yaml'), 'tools:\n  tool_search:\n    enabled: "off"\n');
run(python, [path.join(app, 'server/hermes/bridge.py'), '--check'],
  { env: { ...process.env, HERMES_HOME: path.join(runtime, 'home'), PYTHONPATH: source } });
await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ repository: config.repository, revision: config.revision }, null, 2));
console.log(`Hermes runtime ready (${config.revision.slice(0, 12)}), with the Anthropic provider.`);
