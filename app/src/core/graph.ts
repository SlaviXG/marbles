import type { Note } from "./types";
import type { AgentInfo, AgentTask, ArtifactInfo } from "./agentTypes";

export interface GNode {
  id: string;
  label: string;
  type: "note" | "section" | "url" | "agent" | "task" | "artifact";
  artifactType?: string;
  available?: boolean;
  status?: 'idle' | 'running' | 'unavailable';
  progress?: string;
  activity?: 'waiting' | 'working' | 'done' | 'failed' | 'unavailable';
  activityKey?: string;
  artifactCount?: number;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

const AGENT_RADIUS = 90;
const AGENT_ANGLES: Record<string, number> = { claude: -Math.PI / 2, codex: Math.PI / 6, cursor: 5 * Math.PI / 6 };

function pinned(id: string, label: string, type: GNode["type"], x: number, y: number, artifactType?: string): GNode {
  return { id, label, type, x, y, fx: x, fy: y, ...(artifactType ? { artifactType } : {}) };
}

// Surface deliverables, not implementation files or dependency/build output.
export function isCanvasArtifact(artifact: ArtifactInfo) {
  const parts = artifact.path.replace(/\\/g, '/').split('/');
  if (parts.some(part => part.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'venv'].includes(part))) return false;
  if (/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(artifact.name)) return false;
  return /\.(md|markdown|mdx|pdf|doc|docx|odt|rtf|txt|xls|xlsx|ods|csv|tsv|ppt|pptx|odp|png|jpe?g|webp|svg)$/i.test(artifact.name);
}

export function composeGraph(notes: Record<string, Note>, agents: AgentInfo[], tasks: AgentTask[], includeVaultNodes = false) {
  const graph = includeVaultNodes ? buildGraph(notes) : { nodes: [] as GNode[], links: [] as GLink[] };
  const nodes = [...graph.nodes];
  const links = [...graph.links];
  const visibleAgents = agents.filter((agent) => agent.codingAgent).sort((a, b) => a.id.localeCompare(b.id));
  const agentNodes = new Map<string, GNode>();
  visibleAgents.forEach((agent, index) => {
    const angle = AGENT_ANGLES[agent.id] ?? -Math.PI / 2 + index * 2 * Math.PI / Math.max(visibleAgents.length, 1);
    const status = !agent.available || agent.kind !== 'cli' || !['codex', 'claude'].includes(agent.id)
      ? 'unavailable' : tasks.some(task => task.agentId === agent.id && task.status === 'running') ? 'running' : 'idle';
    const node = pinned(`agent:${agent.id}`, agent.name, 'agent', Math.cos(angle) * AGENT_RADIUS, Math.sin(angle) * AGENT_RADIUS);
    node.available = agent.available;
    node.status = status;
    const latest = tasks.find(task => task.agentId === agent.id && task.status === 'running') ?? tasks.find(task => task.agentId === agent.id);
    node.progress = latest ? `${latest.status === 'completed' ? 'Ready to review' : latest.status === 'failed' ? 'Needs attention' : 'Working'}: ${latest.title || latest.intent?.objective || latest.prompt}` : undefined;
    node.activity = status === 'unavailable' ? 'unavailable' : status === 'running' ? 'working' : latest?.status === 'completed' ? 'done' : latest?.status === 'failed' ? 'failed' : 'waiting';
    node.activityKey = `${node.activity}:${latest?.id ?? 'idle'}`;
    nodes.push(node);
    agentNodes.set(agent.id, node);
  });
  for (const [agentId, parent] of agentNodes) {
    const files = tasks.slice(0, 30).filter(task => task.agentId === agentId && task.status === 'completed')
      .flatMap(task => task.artifacts.filter(isCanvasArtifact).map(artifact => ({ task, artifact })));
    if (!files.length) continue;
    const side = parent.x! < 0 ? -1 : 1;
    const point = { x: parent.x! + side * 90, y: parent.y! - 18 };
    if (files.length > 1) {
      const id = `assets:${agentId}`;
      const stack = pinned(id, `${files.length} files ready`, 'artifact', point.x, point.y, 'stack');
      stack.artifactCount = files.length;
      nodes.push(stack); links.push({ source: parent.id, target: id });
      continue;
    }
    const { task, artifact } = files[0];
    const id = `artifact:${task.id}:${encodeURIComponent(artifact.path)}`;
    const format = /\.(md|markdown|mdx)$/i.test(artifact.name) ? 'markdown'
      : /\.(ppt|pptx|odp)$/i.test(artifact.name) ? 'slides'
      : /\.(doc|docx|odt|rtf)$/i.test(artifact.name) ? 'docx'
      : /\.(xls|xlsx|ods|csv|tsv)$/i.test(artifact.name) ? 'spreadsheet' : artifact.type;
    nodes.push(pinned(id, artifact.name, 'artifact', point.x, point.y, format));
    links.push({ source: parent.id, target: id });
  }
  return { nodes, links };
}
export interface GLink {
  source: string;
  target: string;
}

function hostname(u: string) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

// Derive a graph (notes -> sections -> urls, plus note->note wikilinks) from
// the note model. Pure function, recomputed when the notes map changes.
export function buildGraph(notes: Record<string, Note>) {
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const seen = new Set<string>();

  const add = (id: string, label: string, type: GNode["type"]) => {
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label, type });
    }
  };

  const titleToId: Record<string, string> = {};
  for (const n of Object.values(notes)) titleToId[n.title] = n.id;

  for (const n of Object.values(notes)) {
    add(n.id, n.title, "note");
    for (const s of n.sections) {
      const base = s.heading ? s.id : n.id;
      if (s.heading) {
        add(s.id, s.heading, "section");
        links.push({ source: n.id, target: s.id });
      }
      for (const u of s.urls) {
        add(u, hostname(u), "url");
        links.push({ source: base, target: u });
      }
      for (const l of s.links) {
        const target = titleToId[l];
        if (target) links.push({ source: n.id, target });
      }
    }
  }

  return { nodes, links };
}
