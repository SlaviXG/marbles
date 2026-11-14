import { promises as fs } from 'node:fs';
import path from 'node:path';

const kinds = new Set(['claim', 'note', 'contribution', 'question', 'done']);
const unknownId = filename => `unknown:${path.basename(filename, '.jsonl').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 72) || 'unnamed'}`;
export class SwarmBlackboard {
  constructor({ dir, agents, intervalMs = 1000, maxPerAgent = 200 }) {
    this.dir = dir; this.agents = new Set(agents); this.intervalMs = intervalMs; this.maxPerAgent = maxPerAgent;
    this.offsets = new Map(); this.pending = new Map(); this.counts = new Map(); this.entries = []; this.seq = 0;
    this.turns = new Map(); this.lock = Promise.resolve();
  }
  async init() {
    await fs.mkdir(path.join(this.dir, 'posts'), { recursive: true });
    await fs.mkdir(path.join(this.dir, 'shared'), { recursive: true });
    await fs.writeFile(path.join(this.dir, 'blackboard.jsonl'), '', { flag: 'a' });
    return this;
  }
  setTurn(agentId, turn) { this.turns.set(agentId, turn); }
  poll() {
    this.lock = this.lock.then(() => this.merge());
    return this.lock;
  }
  async merge() {
    const postsDir = path.join(this.dir, 'posts');
    const participantFiles = [...this.agents].map(id => `${id}.jsonl`);
    const strayFiles = (await fs.readdir(postsDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl') && !this.agents.has(entry.name.slice(0, -6)))
      .map(entry => entry.name).sort();
    for (const filename of [...participantFiles, ...strayFiles]) {
      const agentId = this.agents.has(filename.slice(0, -6)) ? filename.slice(0, -6) : unknownId(filename);
      const source = filename;
      const file = path.join(postsDir, filename);
      let handle;
      try { handle = await fs.open(file, 'r'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      try {
        const stat = await handle.stat();
        const old = this.offsets.get(source) ?? 0;
        if (stat.size < old) { this.offsets.set(source, 0); this.pending.set(source, ''); }
        const offset = this.offsets.get(source) ?? 0;
        const bytes = Math.min(stat.size - offset, 1_000_000);
        if (bytes <= 0) continue;
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, offset);
        this.offsets.set(source, offset + bytesRead);
        const lines = ((this.pending.get(source) ?? '') + buffer.toString('utf8', 0, bytesRead)).split('\n');
        this.pending.set(source, lines.pop().slice(-4096));
        for (const line of lines) {
          if ((this.counts.get(source) ?? 0) >= this.maxPerAgent) break;
          let post;
          try { post = JSON.parse(line); } catch { continue; }
          if (!post || !kinds.has(post.kind) || typeof post.text !== 'string' || !post.text.trim() || post.text.length > 2000) continue;
          const entry = { ts: new Date().toISOString(), seq: ++this.seq, agentId, turn: this.turns.get(agentId) ?? 1, kind: post.kind, text: post.text };
          await fs.appendFile(path.join(this.dir, 'blackboard.jsonl'), JSON.stringify(entry) + '\n');
          this.entries.push(entry); this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
        }
      } finally { await handle.close(); }
    }
  }
  start() { this.timer = setInterval(() => { void this.poll().catch(() => {}); }, this.intervalMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); return this.poll(); }
  read(limit = 200) { return this.entries.slice(-Math.max(0, limit)); }
}
