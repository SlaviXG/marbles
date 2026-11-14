import type { Note } from "./types";
import type { AgentInfo, AgentTask, ArtifactInfo, SwarmTask } from "./agentTypes";

export interface GNode {
  id: string;
  label: string;
  type: "note" | "section" | "url" | "agent" | "task" | "artifact" | "swarm" | "post";
  artifactType?: string;
  available?: boolean;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

const AGENT_RADIUS = 42;
const AGENT_ANGLES: Record<string, number> = { claude: -Math.PI / 2, codex: Math.PI / 6, cursor: 5 * Math.PI / 6 };

function pinned(id: string, label: string, type: GNode["type"], x: number, y: number, artifactType?: string): GNode {
  return { id, label, type, x, y, fx: x, fy: y, ...(artifactType ? { artifactType } : {}) };
}

// Small, stable slots keep new children adjacent to their parent. Every third
// child starts another shallow ring, so later tasks do not move existing ones.
function childPosition(parent: GNode, index: number, outward: number, distance: number) {
  const angle = outward + [0, -0.75, 0.75][index % 3];
  const ring = Math.floor(index / 3);
  const radius = distance + ring * 20;
  return { x: parent.x! + Math.cos(angle) * radius, y: parent.y! + Math.sin(angle) * radius };
}

// Surface deliverables, not implementation files or dependency/build output.
export function isCanvasArtifact(artifact: ArtifactInfo) {
  const parts = artifact.path.replace(/\\/g, '/').split('/');
  if (parts.some(part => part.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'venv'].includes(part))) return false;
  if (/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(artifact.name)) return false;
  return /\.(md|markdown|mdx|pdf|doc|docx|odt|rtf|txt|xls|xlsx|ods|csv|tsv|ppt|pptx|odp|png|jpe?g|webp|svg)$/i.test(artifact.name);
}

export function composeGraph(notes: Record<string, Note>, agents: AgentInfo[], tasks: AgentTask[], includeVaultNodes = false, swarms: SwarmTask[] = []) {
  const graph = includeVaultNodes ? buildGraph(notes) : { nodes: [] as GNode[], links: [] as GLink[] };
  const nodes = [...graph.nodes];
  const links = [...graph.links];
  const visibleAgents = agents.filter((agent) => agent.codingAgent).sort((a, b) => a.id.localeCompare(b.id));
  const agentNodes = new Map<string, GNode>();
  visibleAgents.forEach((agent, index) => {
    const angle = AGENT_ANGLES[agent.id] ?? -Math.PI / 2 + index * 2 * Math.PI / Math.max(visibleAgents.length, 1);
    const status = !agent.available || agent.kind !== 'cli' || !['codex', 'claude'].includes(agent.id)
      ? 'unavailable' : tasks.some(task => task.agentId === agent.id && task.status === 'running') || swarms.some(swarm => swarm.agents.includes(agent.id) && ['running', 'evaluating'].includes(swarm.status)) ? 'running' : 'idle';
    const node = pinned(`agent:${agent.id}`, `${agent.name} · ${status}`, 'agent', Math.cos(angle) * AGENT_RADIUS, Math.sin(angle) * AGENT_RADIUS);
    node.available = agent.available;
    nodes.push(node);
    agentNodes.set(agent.id, node);
  });
  const childCounts = new Map<string, number>();
  let fileCount = 0;
  for (const task of tasks.slice(0, 30)) {
    const parent = agentNodes.get(task.agentId);
    if (!parent) continue;
    const outward = Math.atan2(parent.y!, parent.x!);
    for (const artifact of task.artifacts.filter(isCanvasArtifact)) {
      if (fileCount >= 18) break;
      fileCount++;
      const index = childCounts.get(task.agentId) ?? 0;
      childCounts.set(task.agentId, index + 1);
      const id = `artifact:${task.id}:${encodeURIComponent(artifact.path)}`;
      const artifactPoint = childPosition(parent, index, outward, 36);
      const format = /\.(md|markdown|mdx)$/i.test(artifact.name) ? 'markdown'
        : /\.(ppt|pptx|odp)$/i.test(artifact.name) ? 'slides'
        : /\.(doc|docx|odt|rtf)$/i.test(artifact.name) ? 'docx'
        : /\.(xls|xlsx|ods|csv|tsv)$/i.test(artifact.name) ? 'spreadsheet'
        : artifact.type;
      nodes.push(pinned(id, artifact.name, 'artifact', artifactPoint.x, artifactPoint.y, format));
      links.push({ source: `agent:${task.agentId}`, target: id });
    }
  }
  for (const swarm of swarms.slice(0, 20)) {
    const anchor = swarm.agents.map(id => agentNodes.get(id)).find(Boolean);
    const x = anchor?.x ?? 0, y = anchor?.y ?? 0;
    const parent = pinned(`swarm:${swarm.id}`, swarm.goal.slice(0, 36), 'swarm', x + 30, y + 30);
    nodes.push(parent);
    for (const agentId of swarm.agents) if (agentNodes.has(agentId)) links.push({ source: parent.id, target: `agent:${agentId}` });
    for (const [index, post] of (swarm.blackboard ?? []).slice(-12).entries()) {
      const pos = childPosition(parent, index, 0.5, 28);
      const id = `post:${swarm.id}:${post.seq}`;
      nodes.push(pinned(id, `${post.kind}: ${post.text.slice(0, 28)}`, 'post', pos.x, pos.y));
      links.push({ source: parent.id, target: id });
    }
    for (const [index, artifact] of (swarm.artifacts ?? []).filter(isCanvasArtifact).slice(0, 18).entries()) {
      const pos = childPosition(parent, index, 2.5, 38);
      const id = `artifact:${swarm.id}:${encodeURIComponent(artifact.path)}`;
      nodes.push(pinned(id, artifact.name, 'artifact', pos.x, pos.y, artifact.type));
      links.push({ source: parent.id, target: id });
    }
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
