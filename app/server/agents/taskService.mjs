import { spawn } from 'node:child_process';
import { liveEnv } from '../env.mjs';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const workspaceRoot = () => path.resolve(process.env.MARBLES_WORKSPACE_DIR || path.join(os.homedir(), 'marbles-workspace'));
export const taskCapability = (agent) => agent.available === false ? agent.reason || 'Agent unavailable' : agent.kind !== 'cli' ? agent.id === 'cursor' ? 'Cursor CLI not installed. Install with: curl https://cursor.com/install -fsS | bash, then run `cursor-agent login`.' : 'Desktop app has no non-interactive CLI' : !['codex', 'claude', 'cursor'].includes(agent.id) ? 'Task launch is not supported for this CLI yet' : null;
export function launcher(agent, prompt, dir, { allowTools = [], access = liveEnv('MARBLES_AGENT_ACCESS') || 'workspace' } = {}) {
  if (taskCapability(agent)) throw new Error(taskCapability(agent));
  if (agent.id === 'codex') return { command: agent.path, args: ['exec', '-s', access === 'full' ? 'danger-full-access' : 'workspace-write', '-c', 'approval_policy="never"', '--skip-git-repo-check', '-C', dir, prompt], options: { cwd: dir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } };
  if (agent.id === 'cursor') return { command: agent.path, args: ['-p', '--force', '--trust', '--output-format', 'stream-json', '--workspace', dir, prompt], options: { cwd: dir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } };
  // A task may be allowed specific connector tools (for example Gmail) that a
  // headless run would otherwise refuse to call.
  return { command: agent.path, args: ['-p', prompt, ...(access === 'full' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits']), ...(allowTools.length ? ['--allowedTools', ...allowTools] : [])], options: { cwd: dir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] } };
}
const tail = (s, chunk) => (s + chunk).slice(-12000);
const fileType = (name) => {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.xlsx', '.xls', '.csv', '.tsv'].includes(ext)) return 'spreadsheet';
  if (ext === '.docx') return 'docx';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.js', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.sh', '.html', '.css', '.json', '.md'].includes(ext)) return 'code';
  return 'other';
};
export async function scanArtifacts(dir, root = workspaceRoot()) {
  const found = [];
  async function walk(current) {
    if (found.length >= 200) return;
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= 200) break;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && ['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'venv'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push({ path: path.relative(root, full), name: entry.name, type: fileType(entry.name) });
    }
  }
  await walk(dir);
  return found;
}
export function validateArtifactPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0') || relative.split(/[\\/]/).includes('..')) throw new Error('Invalid artifact path');
  const full = path.resolve(root, relative);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid artifact path');
  return full;
}
export async function resolveArtifact(root, relative) {
  const full = validateArtifactPath(root, relative);
  const realRoot = await fs.realpath(root);
  const real = await fs.realpath(full);
  if (!real.startsWith(realRoot + path.sep) || !(await fs.stat(real)).isFile()) throw new Error('Invalid artifact path');
  return real;
}
export class TaskService {
  constructor({ agentDetector, root = workspaceRoot(), spawnProcess = spawn, externalBusy = () => false } = {}) {
    this.agentDetector = agentDetector;
    this.root = root;
    this.spawnProcess = spawnProcess;
    this.externalBusy = externalBusy;
    this.tasks = [];
    this.reservations = new Set();
    this.executions = new Map();
    this.pending = []; // queued tasks, oldest first, waiting for a free agent
    this.draining = false;
  }
  snapshot() { return this.tasks.slice(-50).reverse(); }
  isBusy(agentId) {
    return this.externalBusy(agentId) || this.reservations.has(agentId) || this.tasks.some(task => task.agentId === agentId && ['running', 'cancelling'].includes(task.status));
  }
  cancel(id) {
    const task = this.tasks.find(task => task.id === id);
    if (!task) return null;
    if (task.status === 'queued') {
      this.pending = this.pending.filter(entry => entry.task !== task);
      task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
      return task;
    }
    if (task.status !== 'running') return task;
    const execution = this.executions.get(id);
    if (!execution) throw new Error('Task process is not available.');
    task.status = 'cancelling'; task.updatedAt = new Date().toISOString();
    try { if (execution.child.kill('SIGTERM') === false) throw new Error('Signal rejected'); }
    catch { task.status = 'running'; throw new Error('Could not stop this task process.'); }
    execution.killTimer = setTimeout(() => { try { execution.child.kill('SIGKILL'); } catch {} }, 3000);
    execution.killTimer.unref?.();
    return task;
  }
  /** Start now if an agent is free; otherwise keep the work in line and start it
   * as soon as one is. `agentId` 'auto' takes the first free agent; a named
   * agent is waited for. Nothing is dropped because everyone was busy. */
  async startOrQueue(prompt, metadata = {}, agentId = 'auto') {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) throw new Error('Enter a task under 10,000 characters');
    const usable = (await this.agentDetector()).filter(agent => agent.available !== false && !taskCapability(agent));
    if (!usable.length) throw Object.assign(new Error('No supported CLI agents found. Install and sign in to Codex or Claude Code.'), { code: 'NO_AGENTS' });
    const wanted = agentId !== 'auto' && usable.some(agent => agent.id === agentId) ? agentId : 'auto';
    // Earlier queued work goes first, so a new request cannot jump the line.
    if (!this.pending.some(entry => entry.agentId === 'auto' || entry.agentId === wanted)) {
      try { return wanted === 'auto' ? await this.startIdle(prompt, metadata) : await this.start(wanted, prompt, metadata); }
      catch (error) { if (error.code !== 'AGENT_BUSY') throw error; }
    }
    if (this.pending.length >= 20) throw Object.assign(new Error('The queue is full. Wait for some work to finish.'), { code: 'AGENT_BUSY' });
    const now = new Date().toISOString();
    const task = { id: randomUUID(), agentId: wanted === 'auto' ? '' : wanted, prompt: prompt.trim(), status: 'queued', createdAt: now, updatedAt: now, stdout: '', stderr: '', artifacts: [],
      source: metadata.source ?? 'text', transcript: metadata.transcript, intent: metadata.intent, title: metadata.title, routing: metadata.routing,
      ...(metadata.allowTools ? { allowTools: metadata.allowTools } : {}) };
    this.tasks.push(task);
    this.pending.push({ task, agentId: wanted });
    this.watchQueue();
    return task;
  }
  watchQueue() {
    if (this.queueTimer || !this.pending.length) return;
    // Agents are also freed by swarms and by processes ending; a light poll covers all of them.
    this.queueTimer = setInterval(() => { void this.drain(); }, 1500);
    this.queueTimer.unref?.();
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const agents = (await this.agentDetector()).filter(agent => agent.available !== false && !taskCapability(agent));
      for (const entry of [...this.pending]) {
        const agent = agents.find(item => (entry.agentId === 'auto' || item.id === entry.agentId) && !this.isBusy(item.id));
        if (!agent) continue;
        this.pending = this.pending.filter(item => item !== entry);
        try { await this.start(agent.id, entry.task.prompt, {}, entry.task); }
        catch (error) {
          if (error.code === 'AGENT_BUSY') { this.pending.unshift(entry); continue; }
          entry.task.status = 'failed'; entry.task.stderr = String(error.message).slice(0, 1000); entry.task.updatedAt = new Date().toISOString();
        }
      }
    } finally {
      this.draining = false;
      if (!this.pending.length && this.queueTimer) { clearInterval(this.queueTimer); this.queueTimer = null; }
    }
  }
  async startIdle(prompt, metadata = {}) {
    const agents = (await this.agentDetector()).filter(agent => agent.available !== false && !taskCapability(agent));
    if (!agents.length) throw Object.assign(new Error('No supported CLI agents found. Install and sign in to Codex or Claude Code.'), { code: 'NO_AGENTS' });
    for (const agent of agents) {
      try { return await this.start(agent.id, prompt, metadata); }
      catch (error) { if (error.code !== 'AGENT_BUSY') throw error; }
    }
    throw Object.assign(new Error('All agents are busy. Your request is kept here; retry when an agent is idle.'), { code: 'AGENT_BUSY' });
  }
  async start(agentId, prompt, metadata = {}, queued) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 10000) throw new Error('Enter a task under 10,000 characters');
    const agent = (await this.agentDetector()).find(a => a.id === agentId);
    if (!agent) throw new Error('Agent not found');
    const reason = taskCapability(agent);
    if (reason) throw new Error(reason);
    if (this.isBusy(agentId)) throw Object.assign(new Error('Agent is busy'), { code: 'AGENT_BUSY' });
    this.reservations.add(agentId);
    try {
      const id = queued?.id ?? randomUUID();
      const dir = path.join(this.root, agent.id, id);
      await fs.mkdir(dir, { recursive: true });
      const task = queued ?? { id, agentId, prompt: prompt.trim(), status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stdout: '', stderr: '', artifacts: [], source: metadata.source ?? 'text', transcript: metadata.transcript, intent: metadata.intent, title: metadata.title, routing: metadata.routing };
      // A queued record keeps its identity (and its place on the canvas) when it starts.
      if (queued) { const now = new Date().toISOString(); Object.assign(queued, { agentId, status: 'running', updatedAt: now, startedAt: now }); }
      else this.tasks.push(task);
      if (metadata.allowTools) task.allowTools = metadata.allowTools;
      // Voice-delegated work may include "...and email it to me". Without this a
      // headless Claude is refused its own Gmail connector and the send fails.
      else if (!task.allowTools && task.source === 'voice' && liveEnv('MARBLES_AGENT_GMAIL') !== 'off') task.allowTools = ['mcp__claude_ai_Gmail'];
      const launch = launcher(agent, task.prompt, dir, { allowTools: task.allowTools });
      let child;
      try { child = this.spawnProcess(launch.command, launch.args, launch.options); }
      catch (e) { task.status = 'failed'; task.stderr = String(e.message).slice(0, 1000); return task; }
      const update = () => { task.updatedAt = new Date().toISOString(); scanArtifacts(dir, this.root).then(files => { task.artifacts = files; }).catch(() => {}); };
      child.stdout?.on('data', chunk => { task.stdout = tail(task.stdout, chunk.toString()); update(); });
      child.stderr?.on('data', chunk => { task.stderr = tail(task.stderr, chunk.toString()); update(); });
      let ended = false;
      const finish = (status, message = '') => {
        if (ended) return; ended = true;
        task.status = task.status === 'cancelling' ? 'cancelled' : status;
        if (message) task.stderr = tail(task.stderr, message);
        update(); clearInterval(timer); clearTimeout(this.executions.get(id)?.killTimer); this.executions.delete(id);
        void this.drain();
      };
      child.on('error', e => finish('failed', e.message));
      child.on('close', code => finish(code === 0 ? 'completed' : 'failed'));
      const timer = setInterval(update, 2000);
      timer.unref?.();
      this.executions.set(id, { child });
      return task;
    } finally { this.reservations.delete(agentId); }
  }
}
