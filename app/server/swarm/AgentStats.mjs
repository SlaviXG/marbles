import { promises as fs } from 'node:fs';
import path from 'node:path';
export class AgentStats {
  constructor(root) { this.root = root; this.stats = {}; this.lessons = []; }
  async load() {
    try { this.stats = JSON.parse(await fs.readFile(path.join(this.root, 'swarm-stats.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { this.lessons = (await fs.readFile(path.join(this.root, 'swarm-lessons.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).slice(-20); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return this;
  }
  select(available, size = 2) {
    const total = Object.values(this.stats).reduce((sum, stat) => sum + stat.runs, 0);
    return [...available].sort((a, b) => {
      const rank = id => { const s = this.stats[id]; return !s?.runs ? Infinity : s.meanReward + Math.sqrt(2 * Math.log(Math.max(2, total)) / s.runs); };
      return rank(b.id) - rank(a.id) || a.id.localeCompare(b.id);
    }).slice(0, Math.min(size, available.length)).map(a => a.id);
  }
  async record(agents, reward, contributions = {}, lesson = '') {
    for (const id of agents) { const old = this.stats[id] ?? { runs: 0, rewardSum: 0, meanReward: 0, lastReward: 0, contributionSum: 0 };
      const runs = old.runs + 1, rewardSum = old.rewardSum + reward;
      this.stats[id] = { runs, rewardSum, meanReward: rewardSum / runs, lastReward: reward, contributionSum: old.contributionSum + (contributions[id] ?? 0) };
    }
    await fs.mkdir(this.root, { recursive: true });
    const target = path.join(this.root, 'swarm-stats.json'), temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.stats)); await fs.rename(temp, target);
    if (typeof lesson === 'string' && lesson.trim()) {
      const value = lesson.trim().slice(0, 500); this.lessons.push(value); this.lessons = this.lessons.slice(-20);
      await fs.appendFile(path.join(this.root, 'swarm-lessons.jsonl'), JSON.stringify(value) + '\n');
    }
  }
  snapshot() { return { agents: this.stats, lessons: this.lessons.slice(-20) }; }
}
