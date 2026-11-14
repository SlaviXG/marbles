import type { AgentTask, ArtifactInfo, SwarmTask } from './agentTypes';
import { isCanvasArtifact } from './graph';

export type PresentationPhase = 'idle' | 'approaching' | 'presenting' | 'returning';
export const PRESENTATION_ENTER_MS = 760;
export const PRESENTATION_FOLD_MS = 320;
export const PRESENTATION_RETURN_MS = 960;
export interface Presentation {
  key: string;
  sourceId: string;
  leadAgentId: string;
  title: string;
  artifacts: ArtifactInfo[];
}
export function taskPresentation(task: AgentTask): Presentation {
  return { key: `task:${task.id}`, sourceId: task.id, leadAgentId: task.agentId,
    title: task.title || task.intent?.objective || task.prompt.split('\n')[0].slice(0, 120), artifacts: task.artifacts.filter(isCanvasArtifact) };
}
export function swarmPresentation(swarm: SwarmTask): Presentation {
  return { key: `swarm:${swarm.id}`, sourceId: swarm.id, leadAgentId: swarm.winnerId || swarm.agents[0],
    title: swarm.goal.split('\n')[0].slice(0, 120), artifacts: swarm.artifacts.filter(isCanvasArtifact) };
}
export const artifactSelection = (item: Presentation, index = 0) => `artifact:${item.sourceId}:${encodeURIComponent(item.artifacts[index].path)}`;
export function resolvePresentation(id: string | null, tasks: AgentTask[], swarms: SwarmTask[]) {
  if (!id?.startsWith('artifact:')) return null;
  const [, sourceId, path] = id.split(':');
  const task = tasks.find(item => item.id === sourceId);
  const swarm = swarms.find(item => item.id === sourceId);
  const item = task ? taskPresentation(task) : swarm ? swarmPresentation(swarm) : null;
  if (!item?.leadAgentId) return null;
  const index = item.artifacts.findIndex(artifact => encodeURIComponent(artifact.path) === path);
  // File links in technical details can also refer to source files.
  if (index < 0) {
    const artifact = (task?.artifacts ?? swarm?.artifacts)?.find(file => encodeURIComponent(file.path) === path);
    return artifact ? { item: { ...item, artifacts: [artifact] }, index: 0 } : null;
  }
  return { item, index };
}

/** Initial history is a baseline, never a reason to reopen old results. New
 * completions remain eligible when artifact discovery arrives a poll later. */
export class CompletionTracker {
  private initialized = new Set<string>();
  private previous = new Map<string, { eligible: boolean; emitted: boolean }>();
  observe(kind: 'task' | 'swarm', sources: (AgentTask | SwarmTask)[]): Presentation[] {
    const baseline = !this.initialized.has(kind);
    const ready: Presentation[] = [];
    for (const source of sources) {
      const key = `${kind}:${source.id}`;
      const previous = this.previous.get(key);
      const running = ['running', 'evaluating', 'cancelling'].includes(source.status);
      const entry = previous ?? { eligible: !baseline || running, emitted: false };
      if (running) entry.eligible = true;
      if (source.status === 'completed' && entry.eligible && !entry.emitted) {
        const item = kind === 'task' ? taskPresentation(source as AgentTask) : swarmPresentation(source as SwarmTask);
        if (item.artifacts.length && item.leadAgentId) { ready.push(item); entry.emitted = true; }
      }
      this.previous.set(key, entry);
    }
    this.initialized.add(kind);
    return ready;
  }
}

export function presentationLayout(width: number, height: number) {
  const compact = width < 850;
  const left = compact ? 20 : Math.round(width * .36);
  const top = compact ? (height < 650 ? 145 : 175) : 126;
  const panel = { left, top, width: width - left - (compact ? 20 : 42), height: Math.max(180, height - top - 178) };
  return { panel, dock: compact ? { x: width / 2, y: height < 650 ? 76 : 100 } : { x: left - 94, y: top + 122 } };
}
