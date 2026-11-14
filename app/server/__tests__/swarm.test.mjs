import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SwarmBlackboard } from '../swarm/SwarmBlackboard.mjs';
import { buildSwarmPolicy, buildSwarmPrompt } from '../swarm/swarmPrompt.mjs';
import { teamReward } from '../swarm/teamReward.mjs';
import { AgentStats } from '../swarm/AgentStats.mjs';
import { SwarmService } from '../swarm/SwarmService.mjs';
import { VoiceCommands } from '../agents/voiceCommands.mjs';

const agents = ['codex', 'claude'].map(id => ({ id, kind: 'cli', path: `/bin/${id}`, available: true }));
async function temporary(fn) { const root = await mkdtemp(path.join(os.tmpdir(), 'marbles-swarm-')); try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
function fakeSpawn() { const children = []; const spawnProcess = (_cmd, args, options) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn(() => child.emit('close', 1)); child.options = options; child.args = args; children.push(child); return child; }; return { children, spawnProcess }; }
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Condition not reached'); }
const evaluation = async () => ({ score: 0.8, contributions: { codex: 0.7, claude: 0.3 }, lesson: 'Coordinate early', rationale: 'Good output' });

describe('swarm blackboard', () => {
  it('merges participant files first, skips malformed lines and caps entries', async () => temporary(async root => {
    const board = await new SwarmBlackboard({ dir: root, agents: ['codex'], maxPerAgent: 2 }).init();
    await writeFile(path.join(root, 'posts', 'codex.jsonl'), 'bad\n' + JSON.stringify({ kind: 'claim', text: 'First' }) + '\n' + JSON.stringify({ kind: 'done', text: 'Finished' }) + '\n' + JSON.stringify({ kind: 'note', text: 'Ignored' }) + '\n');
    await writeFile(path.join(root, 'posts', 'claude.jsonl'), JSON.stringify({ kind: 'done', text: 'Unknown' }) + '\n');
    await board.poll(); await board.poll();
    expect(board.read().map(p => [p.seq, p.agentId, p.kind])).toEqual([[1, 'codex', 'claim'], [2, 'codex', 'done'], [3, 'unknown:claude', 'done']]);
    expect((await readFile(path.join(root, 'blackboard.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  }));
  it('attributes stray post files to sanitized, capped unknown ids', async () => temporary(async root => {
    const board = await new SwarmBlackboard({ dir: root, agents: ['codex'] }).init();
    const basename = `session!${'x'.repeat(100)}`;
    await writeFile(path.join(root, 'posts', `${basename}.jsonl`), '{"kind":"contribution","text":"Found it"}\n');
    await board.poll(); await board.poll();
    expect(board.read()).toHaveLength(1);
    expect(board.read()[0]).toMatchObject({ agentId: `unknown:session_${'x'.repeat(64)}`, kind: 'contribution', text: 'Found it' });
  }));
  it('keeps partial lines until newline and rejects oversized text', async () => temporary(async root => {
    const board = await new SwarmBlackboard({ dir: root, agents: ['codex'] }).init();
    const file = path.join(root, 'posts', 'codex.jsonl');
    await writeFile(file, JSON.stringify({ kind: 'note', text: 'partial' })); await board.poll(); expect(board.read()).toHaveLength(0);
    await writeFile(file, JSON.stringify({ kind: 'note', text: 'partial' }) + '\n' + JSON.stringify({ kind: 'note', text: 'x'.repeat(2001) }) + '\n');
    await board.poll(); expect(board.read().map(p => p.text)).toEqual(['partial']);
  }));
});

describe('prompt and reward', () => {
  it('uses byte-identical policy and a distinct identity suffix for each agent', () => {
    const args = { goal: 'Make a report', swarmDir: '/tmp/swarm', budget: 4, lessons: ['learned'], participantIds: ['codex', 'claude'] };
    const policy = buildSwarmPolicy(args);
    const codex = buildSwarmPrompt({ ...args, agentId: 'codex', turn: 1 });
    const claude = buildSwarmPrompt({ ...args, agentId: 'claude', turn: 2 });
    expect(codex.slice(0, policy.length)).toBe(claude.slice(0, policy.length));
    expect(codex).toBe(`${policy}\nYour handle: codex. Your post file: posts/codex.jsonl (append only to this file; teammates: claude)`);
    expect(claude).toBe(`${policy}\nYour handle: claude. Your post file: posts/claude.jsonl (append only to this file; teammates: codex)`);
    expect(policy).toContain('learned');
    expect(policy).not.toContain('codex');
    expect(policy).not.toContain('Turn 1');
    expect(policy).not.toContain('$MARBLES_SWARM_AGENT');
  });
  it('clamps output cost and shares one reward', () => {
    expect(teamReward(1, 30, 120)).toBe(0.9375);
    expect(teamReward(1, 1000, 120)).toBe(0.75);
    expect(teamReward(2, 0, 120)).toBe(1);
  });
});

describe('stats', () => {
  it('persists common reward and selects unseen agents first', async () => temporary(async root => {
    const stats = await new AgentStats(root).load();
    await stats.record(['codex', 'claude'], 0.7, { codex: 0.9, claude: 0.1 }, 'Coordinate');
    expect(stats.stats.codex.meanReward).toBe(stats.stats.claude.meanReward);
    expect(stats.stats.codex.contributionSum).toBe(0.9);
    await stats.record(['codex', 'claude'], 0.5, { codex: 0.2, claude: 0.8 });
    expect(stats.stats.codex.contributionSum).toBeCloseTo(1.1);
    expect(stats.stats.claude.contributionSum).toBeCloseTo(0.9);
    const loaded = await new AgentStats(root).load();
    expect(loaded.lessons).toEqual(['Coordinate']);
    expect(loaded.select([{ id: 'codex' }, { id: 'new' }], 1)).toEqual(['new']);
  }));
});

describe('swarm execution', () => {
  it('relaunches a finished agent before the slowest exits, within budget and concurrency', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: evaluation });
    const swarm = await service.start({ goal: 'Work together', agents: ['codex', 'claude'], maxTurns: 3, concurrency: 2 });
    expect(fake.children).toHaveLength(2);
    const postsDir = path.join(root, 'swarms', swarm.id, 'posts');
    expect(await readFile(path.join(postsDir, 'codex.jsonl'), 'utf8')).toBe('');
    expect(await readFile(path.join(postsDir, 'claude.jsonl'), 'utf8')).toBe('');
    expect(fake.children[0].args.at(-1)).toContain('Your handle: codex. Your post file: posts/codex.jsonl');
    expect(fake.children[1].args[1]).toContain('Your handle: claude. Your post file: posts/claude.jsonl');
    fake.children[0].stdout.emit('data', 'hello'); fake.children[0].emit('close', 0);
    await until(() => fake.children.length === 3);
    expect(fake.children[1].options.env.MARBLES_SWARM_AGENT).toBe('claude');
    expect(fake.children[2].options.env.MARBLES_SWARM_AGENT).toBe('codex');
    fake.children[2].emit('close', 0); fake.children[1].emit('close', 0);
    await until(() => swarm.persisted);
    expect(swarm.runs).toHaveLength(3); expect(swarm.reward).toBeGreaterThan(0);
    expect(service.stats.stats.codex.lastReward).toBe(service.stats.stats.claude.lastReward);
    expect(service.stats.stats.codex.contributionSum).toBe(0.7);
    expect(service.stats.stats.claude.contributionSum).toBe(0.3);
  }));
  it('stops relaunch after every participant posts done', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: evaluation });
    const swarm = await service.start({ goal: 'Finish', agents: ['codex', 'claude'], maxTurns: 8 });
    const posts = path.join(root, 'swarms', swarm.id, 'posts');
    await writeFile(path.join(posts, 'codex.jsonl'), '{"kind":"done","text":"done"}\n');
    await writeFile(path.join(posts, 'claude.jsonl'), '{"kind":"done","text":"done"}\n');
    fake.children.forEach(c => c.emit('close', 0));
    await until(() => swarm.persisted); expect(swarm.runs).toHaveLength(2);
  }));
  it('kills children on timeout', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: evaluation, timeoutMs: 10 });
    const swarm = await service.start({ goal: 'Slow', agents: ['codex'], maxTurns: 1 });
    await until(() => swarm.persisted);
    expect(fake.children[0].kill).toHaveBeenCalled(); expect(swarm.runs[0].status).toBe('timed_out'); expect(swarm.status).toBe('failed');
  }));
  it('picks best solo evaluation', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: async ({ soloDir }) => ({ score: soloDir.endsWith('claude') ? 0.9 : 0.2, contributions: {}, lesson: '', rationale: 'Compared' }) });
    const swarm = await service.start({ goal: 'Compare', agents: ['codex', 'claude'], mode: 'best-of-n' });
    await until(() => fake.children.length === 2); fake.children.forEach(c => c.emit('close', 0));
    await until(() => swarm.persisted); expect(swarm.winnerId).toBe('claude'); expect(swarm.success).toBe(0.9);
  }));
  it('limits simultaneous solo runs', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: evaluation });
    const swarm = await service.start({ goal: 'Compare', agents: ['codex', 'claude'], mode: 'best-of-n', concurrency: 1 });
    await until(() => fake.children.length === 1);
    fake.children[0].emit('close', 0); await until(() => fake.children.length === 2);
    fake.children[1].emit('close', 0); await until(() => swarm.persisted);
  }));
  it('copies persisted lessons into later prompts', async () => temporary(async root => {
    const stats = await new AgentStats(root).load(); await stats.record(['codex'], 0.5, {}, 'Use one outline');
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess, evaluator: evaluation });
    const swarm = await service.start({ goal: 'Write', agents: ['codex'], maxTurns: 1 });
    expect(fake.children[0].args.at(-1)).toContain('Use one outline');
    expect(await readFile(path.join(root, 'swarms', swarm.id, 'lessons.jsonl'), 'utf8')).toContain('Use one outline');
    fake.children[0].emit('close', 0); await until(() => swarm.persisted);
  }));
  it('requires participant contribution keys in the evaluator prompt and discards other keys', async () => temporary(async root => {
    const fake = fakeSpawn(); const service = new SwarmService({ root, agentDetector: async () => agents, spawnProcess: fake.spawnProcess });
    const dir = path.join(root, 'swarm');
    await mkdir(dir);
    const pending = service.evaluate({ goal: 'Write', swarmDir: dir, blackboard: [], files: [], participantIds: ['codex', 'claude'] }, agents, dir);
    await until(() => fake.children.length === 1);
    expect(fake.children[0].args.at(-1)).toContain('keyed only by these participant IDs: ["codex","claude"]');
    await writeFile(path.join(dir, 'eval', 'evaluation.json'), JSON.stringify({ score: 0.8, contributions: { codex: 0.7, claude: 0.3, 'unknown:session': 0.5 }, lesson: '', rationale: 'Done' }));
    fake.children[0].emit('close', 0);
    expect((await pending).contributions).toEqual({ codex: 0.7, claude: 0.3 });
  }));
  it('rejects cursor when only the desktop app is installed and rejects malformed input', async () => temporary(async root => {
    const service = new SwarmService({ root, agentDetector: async () => [...agents, { id: 'cursor', kind: 'desktop', available: true }] });
    await expect(service.start({ goal: '' })).rejects.toThrow('goal');
    await expect(service.start({ goal: 'test', agents: ['cursor'] })).rejects.toThrow('Cursor CLI not installed');
    await expect(service.start({ goal: 'test', agents: ['codex'], concurrency: 5 })).rejects.toThrow('concurrency');
  }));
});

describe('voice swarm routing', () => {
  it('routes keyword requests to swarm even when interpretation says solo', async () => {
    const start = vi.fn(async () => ({ id: 'swarm-1', agents: ['codex'] }));
    const { HermesCoordinator } = await import('../agents/HermesCoordinator.mjs');
    const taskService = { root: '/tmp', agentDetector: async () => [], snapshot: () => [], isBusy: () => false, startIdle: vi.fn() };
    const coordinator = new HermesCoordinator({ taskService, swarmService: { start }, runner: async (_payload, call) => { await call('delegate_work', { collaboration: 'solo', agentId: 'auto', problem: '', objective: 'Write', summary: 'I’ll write the report.', plan: ['Write a report'], assumptions: [], constraints: [], successCriteria: ['Report exists'] }); return { completed: false, interrupted: true }; } });
    const commands = new VoiceCommands({ taskService, swarmService: { start }, coordinator });
    const result = await commands.dispatch({ transcript: 'Have everyone write a report', requestId: 'request-123' });
    expect(result.state).toBe('swarm'); expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'swarm' }));
  });
});
