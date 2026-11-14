import { expect, it, vi } from 'vitest';
import { DisplayTools, DISPLAY_TOOL_NAMES } from '../agents/DisplayTools.mjs';
import { HermesCoordinator } from '../agents/HermesCoordinator.mjs';
import { searchImages, searchYouTube, youtubeId } from '../media/webMedia.mjs';
import { findContacts, isEmail, normalizePhone, placeCall, resolveRecipient, sendEmail } from '../comms/comms.mjs';
import { buildVoicePrompt } from '../agents/coordinatorPolicy.mjs';

const tasks = [{ id: 'task-12345', title: 'Q3 review pack', agentId: 'claude', status: 'completed', artifacts: [{ path: 'out/q3-market-brief.md', name: 'q3-market-brief.md' }] }];
const taskService = { root: '/tmp/marbles-test', snapshot: () => tasks, isBusy: () => false,
  agentDetector: async () => [{ id: 'claude', name: 'Claude Code', kind: 'cli', available: true }, { id: 'codex', name: 'Codex', kind: 'cli', available: true }] };
const swarmService = { snapshot: () => [{ id: 'swarm-12345', title: 'Launch plan', agents: ['claude', 'codex'], artifacts: [] }] };
const tools = (extra = {}) => new DisplayTools({ taskService, swarmService, noteProvider: () => [{ id: 'notes/roadmap.md', title: 'Roadmap' }], ...extra });

it('opens agents, files, tasks, teams and notes by the names people use', async () => {
  const display = tools();
  expect(await display.open({ kind: 'agent', ref: 'Claude' })).toEqual({ kind: 'select', id: 'agent:claude' });
  expect(await display.open({ kind: 'files', ref: 'codex' })).toEqual({ kind: 'select', id: 'assets:codex' });
  expect(await display.open({ kind: 'task', ref: 'q3 review' })).toEqual({ kind: 'select', id: 'task:task-12345' });
  expect(await display.open({ kind: 'team', ref: 'swarm-12345' })).toEqual({ kind: 'select', id: 'swarm:swarm-12345' });
  expect(await display.open({ kind: 'file', ref: 'market brief' })).toEqual({ kind: 'select', id: `artifact:task-12345:${encodeURIComponent('out/q3-market-brief.md')}` });
  expect(await display.open({ kind: 'note', ref: 'roadmap' })).toEqual({ kind: 'select', id: 'notes/roadmap.md' });
  expect(await display.open({ kind: 'close', ref: '' })).toEqual({ kind: 'close' });
  await expect(display.open({ kind: 'file', ref: 'missing.pdf' })).rejects.toThrow(/No generated file/);
});

it('prepares an email or call for confirmation and never sends from the tool', async () => {
  const recipient = vi.fn(async (to, kind) => kind === 'email' ? { name: 'Sam Lee', address: 'sam@example.com' } : { name: 'Sam Lee', address: '+447700900123' });
  const display = tools({ recipient });
  expect(await display.call('draft_email', { to: 'Sam', subject: 'Friday', body: 'See you at 3.', reply: 'Draft ready.' }))
    .toEqual({ kind: 'email', to: 'sam@example.com', name: 'Sam Lee', subject: 'Friday', body: 'See you at 3.' });
  expect(await display.call('place_call', { to: 'Sam', reply: 'Ready.' })).toEqual({ kind: 'call', number: '+447700900123', name: 'Sam Lee' });
  await expect(display.call('draft_email', { to: 'Sam', subject: '', body: 'x' })).rejects.toThrow(/subject/);
});

it('lets Hermes show something as a terminal action without starting a worker', async () => {
  const images = vi.fn(async () => [{ url: 'https://img/a.jpg', full: 'https://img/a.jpg', title: 'Aurora', credit: '' }]);
  const startIdle = vi.fn();
  const runner = vi.fn(async (payload, call) => {
    expect(payload.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(DISPLAY_TOOL_NAMES));
    const receipt = await call('show_images', { query: 'aurora', reply: 'Here are some auroras.' });
    expect(receipt.terminal).toBe(true);
    return { interrupted: true, runtime: { runtime: 'Hermes' } };
  });
  const coordinator = new HermesCoordinator({ taskService: { ...taskService, startIdle }, apiKey: 'k', runner, display: tools({ images }) });
  const result = await coordinator.run({ transcript: 'Show me pictures of the aurora' });
  expect(result).toMatchObject({ state: 'show', reply: 'Here are some auroras.', display: { kind: 'images', query: 'aurora' } });
  expect(startIdle).not.toHaveBeenCalled();
});

it('returns a lookup failure to Hermes so it can ask instead of guessing', async () => {
  const runner = vi.fn(async (_payload, call) => {
    await expect(call('place_call', { to: 'Nobody', reply: 'Calling.' })).rejects.toThrow(/No phone number/);
    await call('respond', { decision: 'clarify', reply: 'What number should I call?' });
    return { runtime: { runtime: 'Hermes' } };
  });
  const recipient = async () => { throw new Error('No phone number found for Nobody in Contacts. Ask the user for it.'); };
  const coordinator = new HermesCoordinator({ taskService, apiKey: 'k', runner, display: tools({ recipient }) });
  expect(await coordinator.run({ transcript: 'Call Nobody' })).toMatchObject({ state: 'clarify' });
});

it('finds pictures and videos from page data, and reads video links directly', async () => {
  const commons = { query: { pages: { 1: { index: 2, title: 'File:Small.png', imageinfo: [{ url: 'https://c/small.png', mime: 'image/png', width: 100 }] },
    2: { index: 1, title: 'File:Aurora over lake.jpg', imageinfo: [{ url: 'https://c/a.jpg', thumburl: 'https://c/a-1280.jpg', mime: 'image/jpeg', width: 4000, height: 3000,
      extmetadata: { Artist: { value: '<a href="x">Jo</a>' } } }] } } } };
  const fetchImages = vi.fn(async url => String(url).includes('commons') ? { ok: true, json: async () => commons } : { ok: true, json: async () => ({ results: [{ url: 'https://o/b.jpg', title: 'Sky', creator: 'Al' }] }) });
  const images = await searchImages('aurora', { fetchImpl: fetchImages });
  expect(images[0]).toMatchObject({ url: 'https://c/a-1280.jpg', full: 'https://c/a.jpg', title: 'Aurora over lake', credit: 'Jo' });
  expect(images.map(image => image.full)).toEqual(['https://c/a.jpg', 'https://o/b.jpg']);
  const page = `<script>var ytInitialData = ${JSON.stringify({ contents: [{ videoRenderer: { videoId: 'DZxsau1mAYc', title: { runs: [{ text: 'Arc reactor' }] }, ownerText: { runs: [{ text: 'Lab' }] }, lengthText: { simpleText: '3:16' } } }] })};</script>`;
  expect(await searchYouTube('arc reactor', { fetchImpl: async () => ({ ok: true, text: async () => page }) })).toEqual([{ videoId: 'DZxsau1mAYc', title: 'Arc reactor', channel: 'Lab', duration: '3:16' }]);
  expect(youtubeId('https://youtu.be/DZxsau1mAYc')).toBe('DZxsau1mAYc');
  expect((await searchYouTube('https://www.youtube.com/watch?v=DZxsau1mAYc', { fetchImpl: () => { throw new Error('no network'); } }))[0].videoId).toBe('DZxsau1mAYc');
  await expect(searchImages('', { fetchImpl: fetchImages })).rejects.toThrow();
});

it('passes email and call details as arguments and validates them first', async () => {
  expect(isEmail('sam@example.com')).toBe(true); expect(isEmail('sam@example')).toBe(false);
  expect(normalizePhone('+44 (7700) 900-123')).toBe('+447700900123'); expect(normalizePhone('call me')).toBeNull();
  const run = vi.fn(async () => '');
  expect(await sendEmail({ to: 'sam@example.com', subject: 'Hi "there"', body: 'Line one\n$(rm -rf)' }, { run, platform: 'darwin' })).toEqual({ sent: true });
  const args = run.mock.calls[0][0];
  expect(args.slice(2)).toEqual(['sam@example.com', 'Hi "there"', 'Line one\n$(rm -rf)']);
  expect(args[1]).not.toContain('rm -rf');
  expect(await sendEmail({ to: 'sam@example.com', subject: 'Hi', body: 'Yo' }, { run, platform: 'linux' })).toMatchObject({ sent: false, link: expect.stringMatching(/^mailto:/) });
  await expect(sendEmail({ to: 'nope', subject: 'Hi', body: 'Yo' }, { run })).rejects.toThrow(/valid email/);
  const open = vi.fn();
  expect(placeCall({ number: '+44 7700 900123' }, { open, platform: 'darwin' })).toEqual({ started: true });
  expect(open).toHaveBeenCalledWith('tel:+447700900123');
  expect(() => placeCall({ number: 'tel:;rm' }, { open })).toThrow();
  const contacts = async () => JSON.stringify([{ name: 'Sam Lee', emails: ['sam@example.com', 'bad'], phones: ['07700 900123'] }]);
  expect(await findContacts('Sam', { run: contacts, platform: 'darwin' })).toEqual([{ name: 'Sam Lee', emails: ['sam@example.com'], phones: ['07700900123'] }]);
  expect(await resolveRecipient('Sam', 'email', { run: contacts, platform: 'darwin' })).toEqual({ name: 'Sam Lee', address: 'sam@example.com' });
  expect(await resolveRecipient('a@b.co', 'email', { run: contacts })).toEqual({ name: '', address: 'a@b.co' });
  await expect(resolveRecipient('Sam', 'call', { run: async () => '[]', platform: 'darwin' })).rejects.toThrow(/No phone number/);
});

it('tells a worker how to build real slides or a workbook only when asked for one', () => {
  const intent = { problem: '', objective: 'Make a deck', summary: 's', plan: ['a'], assumptions: [], constraints: [], successCriteria: ['c'], collaboration: 'solo', agentId: 'auto' };
  expect(buildVoicePrompt('Make a presentation about Q3', intent)).toContain('make-office.mjs');
  expect(buildVoicePrompt('Write a summary', { ...intent, objective: 'Write summary.md' })).not.toContain('make-office.mjs');
});

// ---- the queue and several tasks in one request ----
import { TaskService } from '../agents/taskService.mjs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

function queueService() {
  const children = [];
  const spawnProcess = () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true; children.push(child); return child; };
  const service = new TaskService({ root: path.join(os.tmpdir(), `marbles-queue-${process.pid}-${Math.round(performance.now())}`), spawnProcess,
    agentDetector: async () => [{ id: 'codex', name: 'Codex', kind: 'cli', command: 'codex', available: true, codingAgent: true }] });
  return { service, children };
}

it('queues work when every agent is busy and starts it, in order, as agents free up', async () => {
  const { service, children } = queueService();
  const first = await service.startOrQueue('Write the brief', { title: 'Brief' });
  const second = await service.startOrQueue('Build the budget', { title: 'Budget' });
  const third = await service.startOrQueue('Draft the deck', { title: 'Deck' });
  expect([first.status, second.status, third.status]).toEqual(['running', 'queued', 'queued']);
  expect(service.snapshot().map(task => task.title)).toEqual(['Deck', 'Budget', 'Brief']);
  children[0].emit('close', 0);
  await vi.waitFor(() => expect(second.status).toBe('running'));
  expect(second.agentId).toBe('codex'); expect(second.startedAt).toBeTruthy(); expect(third.status).toBe('queued');
  expect(service.cancel(third.id).status).toBe('cancelled');
  children[1].emit('close', 0);
  await vi.waitFor(() => expect(second.status).toBe('completed'));
  expect(children).toHaveLength(2); expect(service.pending).toHaveLength(0);
});

it('delegates every task named in one request, not just the first', async () => {
  const plan = n => ({ problem: '', objective: `Deliverable ${n}`, summary: `I’ll make deliverable ${n}.`, plan: ['Do it'], assumptions: [], constraints: [], successCriteria: ['Exists'], collaboration: 'solo', agentId: 'auto' });
  let n = 0;
  const startOrQueue = vi.fn(async (_prompt, metadata) => ({ id: `task-000${++n}`, agentId: n === 1 ? 'codex' : '', status: n === 1 ? 'running' : 'queued', title: metadata.title, artifacts: [] }));
  const runner = vi.fn(async (payload, call) => {
    expect(payload.tools.map(tool => tool.name)).toContain('delegate_many');
    expect((await call('delegate_many', { tasks: [plan(1), plan(2), plan(3)] })).terminal).toBe(true);
    return { interrupted: true, runtime: { runtime: 'Hermes' } };
  });
  const coordinator = new HermesCoordinator({ taskService: { ...taskService, startOrQueue }, apiKey: 'k', runner });
  const result = await coordinator.run({ transcript: 'Write the brief, build the budget and draft the deck' });
  expect(startOrQueue).toHaveBeenCalledTimes(3);
  expect(result.state).toBe('assigned'); expect(result.tasks.map(task => task.title)).toEqual(['Deliverable 1', 'Deliverable 2', 'Deliverable 3']);
  expect(result.reply).toBe('One started, two queued.');
  await expect(new HermesCoordinator({ taskService: { ...taskService, startOrQueue }, apiKey: 'k',
    runner: async (_payload, call) => { await call('delegate_many', { tasks: [plan(1)] }); } }).run({ transcript: 'x' })).rejects.toThrow();
});

// ---- configuration, memory and what was said meanwhile ----
import { envFiles } from '../env.mjs';
import { VoiceCommands } from '../agents/voiceCommands.mjs';
import fsp from 'node:fs/promises';

it('finds the main checkout’s .env from a linked worktree', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'marbles-env-'));
  const main = path.join(base, 'main'), tree = path.join(base, 'tree');
  await fsp.mkdir(path.join(main, '.git', 'worktrees', 'tree'), { recursive: true });
  await fsp.mkdir(tree);
  await fsp.writeFile(path.join(main, '.env'), 'ELEVENLABS_API_KEY=abc\n');
  await fsp.writeFile(path.join(tree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'tree')}\n`);
  expect(envFiles(tree)).toEqual([path.join(main, '.env')]);
  await fsp.writeFile(path.join(tree, '.env'), 'X=1\n');
  expect(envFiles(tree)).toEqual([path.join(tree, '.env'), path.join(main, '.env')]);
  expect(envFiles(main)).toEqual([path.join(main, '.env')]);
});

it('puts the newest request first, still handles what was said earlier, and remembers', async () => {
  const run = vi.fn()
    .mockResolvedValueOnce({ state: 'show', reply: 'Here are the pictures.', display: { kind: 'images', query: 'aurora', images: [] } })
    .mockResolvedValueOnce({ state: 'assigned', reply: 'Drafting the brief.', task: { id: 'task-0001' }, intent: { objective: 'Brief' } });
  const remember = vi.fn(async (memory, turns) => `${memory} | ${turns.length} turns folded`);
  const commands = new VoiceCommands({ taskService: { snapshot: () => [] }, coordinator: { run, remember } });
  const result = await commands.dispatch({ transcript: 'Show me pictures of the aurora', earlier: ['Write the Q3 brief'], requestId: 'request-0001', conversationId: 'conversation-1' });
  expect(run.mock.calls[0][0]).toMatchObject({ transcript: 'Show me pictures of the aurora', earlier: ['Write the Q3 brief'] });
  expect(run.mock.calls[1][0].transcript).toBe('Write the Q3 brief');
  expect(result.state).toBe('show'); expect(result.followUp).toMatchObject({ state: 'assigned', reply: 'Drafting the brief.' });
  // A delegation already covers earlier requests (delegate_many), so no second pass.
  run.mockResolvedValue({ state: 'assigned', reply: 'Two tasks under way.', task: { id: 'task-0002' }, intent: { objective: 'x' } });
  await commands.dispatch({ transcript: 'And a budget', earlier: ['Make a deck'], requestId: 'request-0002', conversationId: 'conversation-1' });
  expect(run).toHaveBeenCalledTimes(3);
  for (let i = 3; i < 8; i++) await commands.dispatch({ transcript: `Task ${i}`, requestId: `request-000${i}`, conversationId: 'conversation-1' });
  const conversation = commands.conversations.get('conversation-1');
  await conversation.remembering;
  expect(conversation.history).toHaveLength(8);
  expect(remember).toHaveBeenCalled(); expect(conversation.memory).toContain('turns folded');
  expect(run.mock.calls.at(-1)[0].memory).toBeDefined();
  expect(() => commands.dispatch({ transcript: 'x', earlier: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], requestId: 'request-0099', conversationId: 'conversation-1' })).toThrow();
});
