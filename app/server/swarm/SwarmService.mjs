import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launcher, scanArtifacts, taskCapability, workspaceRoot } from '../agents/taskService.mjs';
import { SwarmBlackboard } from './SwarmBlackboard.mjs';
import { buildSwarmPrompt } from './swarmPrompt.mjs';
import { teamReward } from './teamReward.mjs';
import { AgentStats } from './AgentStats.mjs';
import { writeFixtures } from '../scenarios/scenarios.mjs';

const now = () => new Date().toISOString();
const error = (message, code = 'INVALID') => Object.assign(new Error(message), { code });
const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
async function filesIn(dir) {
  try { return (await scanArtifacts(dir, dir)).filter(file => !file.path.startsWith('eval/')); } catch { return []; }
}
export async function heuristicEvaluator({ swarmDir, soloDir, blackboard = [] }) {
  const dir = path.join(soloDir ?? swarmDir, 'shared');
  const files = await filesIn(dir);
  let hasFiles = false;
  for (const file of files) { try { if ((await fs.stat(path.join(dir, file.path))).size > 0) { hasFiles = true; break; } } catch {} }
  return { score: hasFiles ? blackboard.some(post => post.kind === 'done') ? 0.5 : 0.25 : 0, contributions: {}, lesson: '', rationale: 'Fallback file and completion check' };
}
export class SwarmService {
  constructor({ agentDetector, root = workspaceRoot(), spawnProcess = spawn, evaluator, timeoutMs = 600_000, perAgentCharBudget = 60_000, taskService } = {}) {
    this.agentDetector = agentDetector; this.root = root; this.spawnProcess = spawnProcess; this.evaluator = evaluator;
    this.timeoutMs = timeoutMs; this.perAgentCharBudget = perAgentCharBudget; this.taskService = taskService;
    this.swarms = []; this.children = new Map(); this.boards = new Map(); this.reservations = new Set(); this.stats = new AgentStats(root); this.ready = this.stats.load();
  }
  snapshot() { return this.swarms.slice(-50).reverse().map(s => ({ ...s, blackboard: this.boards.get(s.id)?.read(200) ?? s.blackboard })); }
  get(id) { return this.swarms.find(s => s.id === id); }
  async detail(id) {
    const swarm = this.get(id); if (!swarm) return null;
    const board = this.boards.get(id); if (board) await board.poll();
    let artifacts = swarm.artifacts;
    if (swarm.mode === 'swarm') { try { artifacts = await scanArtifacts(path.join(swarm.dir, 'shared'), path.dirname(path.dirname(swarm.dir))); } catch {} }
    return { ...swarm, blackboard: board?.read(200) ?? swarm.blackboard, artifacts };
  }
  isBusy(agentId) { return this.reservations.has(agentId) || this.swarms.some(s => ['running', 'evaluating'].includes(s.status) && s.agents.includes(agentId)); }
  async start({ goal, agents, mode = 'swarm', maxTurns, concurrency, size = 2, fixtures = [], privateFixtures = {}, routing, workspaceRoot: runRoot } = {}) {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 6000) throw error('Enter a goal under 6,000 characters');
    if (!['swarm', 'best-of-n'].includes(mode)) throw error('Invalid swarm mode');
    if (agents !== undefined && (!Array.isArray(agents) || agents.length < 1 || agents.length > 4 || new Set(agents).size !== agents.length || agents.some(id => typeof id !== 'string'))) throw error('Choose 1 to 4 distinct agents');
    if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 8)) throw error('maxTurns must be 1 to 8');
    if (size !== undefined && (!Number.isInteger(size) || size < 1 || size > 4)) throw error('size must be 1 to 4');
    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)) throw error('concurrency must be 1 to 4');
    await this.ready;
    const detected = await this.agentDetector();
    const available = detected.filter(a => a.available !== false && !taskCapability(a) && !this.isBusy(a.id) && !this.taskService?.isBusy(a.id));
    const ids = agents ?? this.stats.select(available, size);
    if (!ids.length) throw error('No supported CLI agents found', 'NO_AGENTS');
    for (const id of ids) {
      const agent = detected.find(a => a.id === id);
      if (!agent) throw error(`Agent ${id} not found`);
      if (agent.available === false) throw error(`Agent ${id} unavailable`);
      if (taskCapability(agent)) throw error(taskCapability(agent));
      if (this.isBusy(id) || this.taskService?.isBusy(id)) throw error(`Agent ${id} is busy`, 'AGENT_BUSY');
    }
    ids.forEach(id => this.reservations.add(id));
    const id = randomUUID(), activeRoot = runRoot ?? this.root, dir = path.join(activeRoot, 'swarms', id);
    try { await fs.mkdir(dir, { recursive: true }); } catch (e) { ids.forEach(id => this.reservations.delete(id)); throw e; }
    let board;
    try {
      board = mode === 'swarm' ? await new SwarmBlackboard({ dir, agents: ids }).init() : null;
      if (board) await Promise.all(ids.map(agentId => fs.writeFile(path.join(dir, 'posts', `${agentId}.jsonl`), '', { flag: 'a' })));
      await fs.writeFile(path.join(dir, 'lessons.jsonl'), this.stats.lessons.slice(-5).map(lesson => JSON.stringify(lesson)).join('\n') + (this.stats.lessons.length ? '\n' : ''));
      if (mode === 'swarm') {
        await writeFixtures(dir, fixtures);
        for (const [index, agentId] of ids.entries()) {
          const privateDir = path.join(dir, 'private', agentId);
          await writeFixtures(privateDir, privateFixtures[index] ?? []);
        }
      }
    } catch (e) { ids.forEach(id => this.reservations.delete(id)); throw e; }
    const swarm = { id, goal: goal.trim(), mode, agents: ids, status: 'running', createdAt: now(), endedAt: null,
      maxTurns: maxTurns ?? Math.min(8, 2 * ids.length), concurrency: concurrency ?? Math.min(ids.length, 3), runs: [], blackboard: [], artifacts: [], reward: null, success: null, tokenProxy: 0, contributions: {}, rationale: '', lesson: '', routing };
    swarm.dir = dir;
    swarm.fixtures = fixtures; swarm.privateFixtures = privateFixtures;
    this.swarms.push(swarm); if (this.swarms.length > 50) this.swarms.shift();
    this.children.set(id, new Set()); if (board) this.boards.set(id, board);
    const timer = setTimeout(() => { swarm.timedOut = true; for (const child of this.children.get(id) ?? []) child.kill?.(); }, this.timeoutMs);
    timer.unref?.();
    void this.execute(swarm, dir, board, detected).catch(e => { swarm.status = 'failed'; swarm.error = e.message; }).finally(async () => {
      clearTimeout(timer); await board?.stop().catch(() => {});
      swarm.blackboard = board?.read(200) ?? []; swarm.endedAt = now(); this.children.delete(id); this.boards.delete(id); ids.forEach(id => this.reservations.delete(id));
      try { await fs.writeFile(path.join(dir, 'swarm.json'), JSON.stringify(swarm, null, 2));
        await fs.appendFile(path.join(this.root, 'swarm-runs.jsonl'), JSON.stringify({ id, mode, goal: swarm.goal, agents: ids, reward: swarm.reward, success: swarm.success, tokenProxy: swarm.tokenProxy, turns: swarm.runs.length, createdAt: swarm.createdAt, endedAt: swarm.endedAt }) + '\n');
      } catch (e) { swarm.error = e.message; }
      swarm.persisted = true;
    });
    return swarm;
  }
  async execute(swarm, dir, board, detected) {
    if (swarm.mode === 'best-of-n') {
      const results = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(swarm.concurrency, swarm.agents.length) }, async () => {
        while (next < swarm.agents.length && swarm.status !== 'cancelled' && !swarm.timedOut) {
          const id = swarm.agents[next++];
          const soloDir = path.join(dir, 'solo', id), sharedDir = path.join(soloDir, 'shared'); await fs.mkdir(sharedDir, { recursive: true });
          await writeFixtures(soloDir, swarm.fixtures);
          await writeFixtures(soloDir, swarm.privateFixtures[swarm.agents.indexOf(id)] ?? []);
          await this.run(swarm, detected.find(a => a.id === id), `${swarm.goal}\nRead input/ and write the requested deliverable in shared/.`, soloDir, 1);
          const files = await filesIn(sharedDir);
          const evaluation = await this.evaluate({ goal: swarm.goal, swarmDir: dir, soloDir, blackboard: [], files, participantIds: [id] }, detected, dir);
          results.push({ agentId: id, evaluation, soloDir, sharedDir, files });
        }
      }));
      if (swarm.status === 'cancelled') return;
      if (!results.length) { swarm.status = 'failed'; return; }
      swarm.status = 'evaluating';
      const best = results.sort((a, b) => b.evaluation.score - a.evaluation.score)[0];
      swarm.winnerId = best.agentId; swarm.artifacts = await scanArtifacts(best.sharedDir, path.dirname(path.dirname(dir)));
      await this.finish(swarm, best.evaluation);
      return;
    }
    board.start();
    const done = new Set(), busy = new Set(), turns = new Map();
    let launched = 0;
    await new Promise(resolve => {
      const schedule = () => {
        if (swarm.status === 'cancelled' || swarm.timedOut) { if (!busy.size) resolve(); return; }
        for (const id of swarm.agents) {
          if (busy.size >= swarm.concurrency || launched >= swarm.maxTurns || done.has(id) || busy.has(id)) continue;
          busy.add(id); launched++; const turn = (turns.get(id) ?? 0) + 1; turns.set(id, turn); board.setTurn(id, turn);
          const prompt = buildSwarmPrompt({ goal: swarm.goal, swarmDir: dir, lessons: this.stats.lessons.slice(-5), budget: swarm.maxTurns, agentId: id, participantIds: swarm.agents }) + (swarm.privateFixtures[swarm.agents.indexOf(id)]?.length ? `\nYour private inputs: private/${id}/. Read only this private directory and share relevant findings through your post file.` : '');
          this.run(swarm, detected.find(a => a.id === id), prompt, dir, turn, { MARBLES_SWARM_AGENT: id, MARBLES_SWARM_DIR: dir }).then(async () => {
            await board.poll(); for (const post of board.read()) if (post.kind === 'done') done.add(post.agentId);
          }).catch(e => { swarm.error = e.message; }).finally(() => { busy.delete(id); schedule(); });
        }
        if (!busy.size && (launched >= swarm.maxTurns || done.size === swarm.agents.length || swarm.status === 'cancelled' || swarm.timedOut)) resolve();
      };
      schedule();
    });
    await board.poll(); swarm.blackboard = board.read(200);
    if (swarm.status === 'cancelled') return;
    swarm.artifacts = await scanArtifacts(path.join(dir, 'shared'), path.dirname(path.dirname(dir)));
    swarm.status = 'evaluating';
    const evaluation = await this.evaluate({ goal: swarm.goal, swarmDir: dir, blackboard: swarm.blackboard, files: swarm.artifacts, participantIds: swarm.agents }, detected, dir);
    await this.finish(swarm, evaluation);
  }
  async run(swarm, agent, prompt, dir, turn, env = {}) {
    const record = { agentId: agent.id, turn, status: 'running', startedAt: now(), endedAt: null, outputChars: 0, stdout: '' };
    swarm.runs.push(record);
    const launch = launcher(agent, prompt, dir);
    let child;
    try { child = this.spawnProcess(launch.command, launch.args, { ...launch.options, env: { ...process.env, ...env } }); }
    catch (e) { record.status = 'failed'; record.endedAt = now(); record.stdout = String(e.message).slice(-4000); return record; }
    this.children.get(swarm.id)?.add(child);
    const onData = chunk => { const text = chunk.toString(); record.outputChars += text.length; record.stdout = (record.stdout + text).slice(-4000); };
    child.stdout?.on('data', onData); child.stderr?.on('data', onData);
    await new Promise(resolve => { let ended = false; const finish = (status) => { if (ended) return; ended = true; record.status = swarm.timedOut ? 'timed_out' : swarm.status === 'cancelled' ? 'cancelled' : status; record.endedAt = now(); this.children.get(swarm.id)?.delete(child); resolve(); };
      child.on('error', () => finish('failed')); child.on('close', code => finish(code === 0 ? 'completed' : 'failed'));
    });
    swarm.tokenProxy += record.outputChars;
    return record;
  }
  async evaluate(context, detected, dir) {
    if (this.evaluator) return this.normalize(await this.evaluator(context), context.participantIds);
    const agent = detected.find(a => a.id === 'codex' && !taskCapability(a)) ?? detected.find(a => !taskCapability(a));
    if (!agent) return heuristicEvaluator(context);
    const evalDir = path.join(dir, 'eval'); await fs.mkdir(evalDir, { recursive: true });
    const prompt = `Evaluate the completed team goal. Inspect deliverables at ${path.join(context.soloDir ?? dir, 'shared')} and the blackboard excerpt below. Write ONLY a JSON file at ${path.join(evalDir, 'evaluation.json')} with keys score (0..1), contributions (object of participant ID to share, keyed only by these participant IDs: ${JSON.stringify(context.participantIds)}), lesson (short string), rationale (string). Goal: ${context.goal}\nFiles: ${JSON.stringify(context.files).slice(0, 6000)}\nBlackboard: ${JSON.stringify(context.blackboard).slice(-8000)}`;
    let child; const children = this.children.get(path.basename(dir));
    try {
      const launch = launcher(agent, prompt, evalDir);
      child = this.spawnProcess(launch.command, launch.args, { ...launch.options, env: process.env });
      children?.add(child);
      await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Evaluator failed'))); });
      return this.normalize(JSON.parse(await fs.readFile(path.join(evalDir, 'evaluation.json'), 'utf8')), context.participantIds);
    } catch { return heuristicEvaluator(context); }
    finally { if (child) children?.delete(child); }
  }
  normalize(value, participantIds = []) {
    if (!value || typeof value.score !== 'number' || !Number.isFinite(value.score) || typeof value.lesson !== 'string' || typeof value.rationale !== 'string' || !value.contributions || typeof value.contributions !== 'object' || Array.isArray(value.contributions)) throw error('Invalid evaluation');
    const participants = new Set(participantIds);
    return { score: clamp(value.score), contributions: Object.fromEntries(Object.entries(value.contributions).filter(([id, n]) => participants.has(id) && typeof n === 'number' && Number.isFinite(n)).map(([id, n]) => [id, clamp(n)])), lesson: value.lesson.slice(0, 500), rationale: value.rationale.slice(0, 2000), checks: Array.isArray(value.checks) ? value.checks : [] };
  }
  async finish(swarm, evaluation) {
    if (swarm.status === 'cancelled') return; swarm.success = evaluation.score; swarm.reward = teamReward(evaluation.score, swarm.tokenProxy, swarm.agents.length * this.perAgentCharBudget);
    swarm.contributions = evaluation.contributions; swarm.lesson = evaluation.lesson; swarm.rationale = evaluation.rationale; swarm.checks = evaluation.checks;
    await this.stats.record(swarm.agents, swarm.reward, evaluation.contributions, evaluation.lesson);
    swarm.status = swarm.timedOut ? 'failed' : 'completed';
  }
  cancel(id) { const swarm = this.get(id); if (!swarm) return null; if (swarm.status === 'running' || swarm.status === 'evaluating') { swarm.status = 'cancelled'; for (const child of this.children.get(id) ?? []) child.kill?.(); } return swarm; }
  statsSnapshot() { return this.stats.snapshot(); }
}
