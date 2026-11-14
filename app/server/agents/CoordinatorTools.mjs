import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveArtifact, scanArtifacts } from './taskService.mjs';
import { agentLog, redactSecrets } from './logs.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1, maxLength: 1000 };
export const INSPECTION_TOOLS = [
  { name: 'inspect_agent', description: 'Check a discovered agent, its managed work and latest available CLI session log. Unmanaged logs are not necessarily from Marbles.', input_schema: object({ agentId: string }) },
  { name: 'inspect_work', description: 'Read the latest state, plan, output/log tail, files and blackboard of a known task or swarm.', input_schema: object({ id: string, kind: { type: 'string', enum: ['task', 'swarm'] } }) },
  { name: 'find_assets', description: 'Find generated files by name or relative path in the Marbles workspace. Use an empty query to list files.', input_schema: object({ query: { type: 'string', maxLength: 200 } }) },
  { name: 'read_asset', description: 'Read a generated text/code/CSV asset, or get metadata for a binary document/image. Delegate binary analysis to a worker with its known path.', input_schema: object({ path: string }) },
  { name: 'search_notes', description: 'Find notes/documents in the connected vault by title or content. An empty query lists recent notes.', input_schema: object({ query: { type: 'string', maxLength: 200 } }) },
  { name: 'read_note', description: 'Read a note by its registered ID, including its real source path. Read only.', input_schema: object({ id: string }) },
  { name: 'cancel_work', description: 'Stop a Marbles-managed task/swarm only when the user asks to stop or cancel it. Cannot stop unrelated machine processes.', input_schema: object({ id: string, kind: { type: 'string', enum: ['task', 'swarm'] } }) },
];
const trim = (value, size = 4000) => redactSecrets(value).slice(-size);
export function workDetails(record) {
  return { id: record.id, title: record.title, status: record.status, agentId: record.agentId, agents: record.agents, intent: record.intent,
    artifacts: record.artifacts?.slice(0, 20), output: trim(record.stdout ?? record.rationale), error: trim(record.stderr ?? record.error, 1500),
    runs: record.runs?.slice(-3).map(run => ({ agentId: run.agentId, status: run.status, output: trim(run.stdout, 1500) })),
    blackboard: record.blackboard?.slice(-8).map(post => ({ agentId: post.agentId, kind: post.kind, text: trim(post.text, 500) })) };
}

export class CoordinatorTools {
  constructor({ taskService, swarmService, noteProvider = () => [], readAgentLog = agentLog }) {
    Object.assign(this, { taskService, swarmService, noteProvider, readAgentLog });
  }
  async work(id, kind) {
    const record = kind === 'task' ? this.taskService.snapshot().find(task => task.id === id) : kind === 'swarm' ? await this.swarmService?.detail(id) : null;
    if (!record) throw new Error('That work item was not found. Inspect current context to find its ID.');
    return record;
  }
  async call(name, input) {
    if (!input || typeof input !== 'object') throw new Error('Tool input must be an object.');
    if (name === 'inspect_agent') {
      if (typeof input.agentId !== 'string') throw new Error('Supply an agent ID.');
      const agent = (await this.taskService.agentDetector()).find(agent => agent.id === input.agentId);
      if (!agent) throw new Error('Agent not found.');
      return { id: agent.id, name: agent.name, kind: agent.kind, managedBusy: this.taskService.isBusy(agent.id),
        managedTasks: this.taskService.snapshot().filter(task => task.agentId === agent.id).slice(0, 3).map(workDetails),
        managedSwarms: (this.swarmService?.snapshot?.() ?? []).filter(swarm => swarm.agents.includes(agent.id)).slice(0, 3).map(workDetails),
        latestSession: await this.readAgentLog(agent.id) };
    }
    if (['inspect_work', 'cancel_work'].includes(name)) {
      if (typeof input.id !== 'string' || !['task', 'swarm'].includes(input.kind)) throw new Error('Supply a work ID and kind.');
      const record = await this.work(input.id, input.kind);
      if (name === 'inspect_work') return workDetails(record);
      const stopped = input.kind === 'task' ? this.taskService.cancel(input.id) : this.swarmService.cancel(input.id);
      if (!stopped) throw new Error('Could not stop this work item.');
      return { id: stopped.id, status: stopped.status };
    }
    if (name === 'find_assets') {
      if (typeof input.query !== 'string' || input.query.length > 200) throw new Error('Supply a search query under 200 characters.');
      let files;
      try { files = await scanArtifacts(this.taskService.root, this.taskService.root); }
      catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      return { root: this.taskService.root, files: files.filter(file => `${file.name} ${file.path}`.toLowerCase().includes(input.query.toLowerCase())).slice(0, 25) };
    }
    if (name === 'read_asset') {
      if (typeof input.path !== 'string' || input.path.split(/[\\/]/).some(part => part.startsWith('.')) || /(?:credentials|secrets|tokens)\.(?:json|ya?ml)$/i.test(input.path)) throw new Error('Choose a generated document or asset.');
      const file = await resolveArtifact(this.taskService.root, input.path);
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        const metadata = { path: input.path, absolutePath: file, size: stat.size, type: path.extname(file).slice(1) };
        if (!/\.(?:md|txt|csv|tsv|json|ya?ml|xml|html|css|js|ts|tsx|jsx|py|rs|go|sh|log)$/i.test(file)) return { ...metadata, note: 'Binary asset. Delegate inspection/conversion to a worker using this path.' };
        const buffer = Buffer.alloc(Math.min(stat.size, 8000));
        await handle.read(buffer, 0, buffer.length, 0);
        return { ...metadata, text: trim(buffer.toString('utf8'), 8000), truncated: stat.size > buffer.length };
      } finally { await handle.close(); }
    }
    if (name === 'search_notes' || name === 'read_note') {
      const notes = await this.noteProvider();
      if (name === 'read_note') {
        const note = notes.find(note => note.id === input.id);
        if (!note) throw new Error('Note not found.');
        return { id: note.id, title: note.title, path: note.path, text: trim(note.sections.map(section => section.content).join('\n'), 8000) };
      }
      if (typeof input.query !== 'string' || input.query.length > 200) throw new Error('Supply a search query under 200 characters.');
      const query = input.query.toLowerCase();
      return notes.filter(note => `${note.title} ${note.sections.map(section => section.content).join(' ')}`.toLowerCase().includes(query)).slice(0, 12)
        .map(note => ({ id: note.id, title: note.title, path: note.path, excerpt: trim(note.sections.map(section => section.content).join(' '), 300) }));
    }
    throw new Error('Unknown inspection tool.');
  }
}
