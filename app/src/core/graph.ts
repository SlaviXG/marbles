import type { Note } from "./types";
import type { AgentInfo, AgentTask } from "./agentTypes";

export interface GNode {
  id: string;
  label: string;
  type: "note" | "section" | "url" | "agent" | "task" | "artifact";
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
    const node = pinned(`agent:${agent.id}`, `${agent.name} · ${status}`, 'agent', Math.cos(angle) * AGENT_RADIUS, Math.sin(angle) * AGENT_RADIUS);
    node.available = agent.available;
    nodes.push(node);
    agentNodes.set(agent.id, node);
  });
  const childCounts = new Map<string, number>();
  for (const task of tasks.slice(0, 30).reverse()) {
    const parent = agentNodes.get(task.agentId);
    if (!parent) continue;
    const index = childCounts.get(task.agentId) ?? 0;
    childCounts.set(task.agentId, index + 1);
    const outward = Math.atan2(parent.y!, parent.x!);
    const point = childPosition(parent, index, outward, 24);
    const taskNode = pinned(`task:${task.id}`, (task.title ?? task.prompt).slice(0, 48), 'task', point.x, point.y);
    nodes.push(taskNode);
    links.push({ source: `agent:${task.agentId}`, target: `task:${task.id}` });
    for (const [artifactIndex, artifact] of task.artifacts.entries()) {
      const id = `artifact:${task.id}:${encodeURIComponent(artifact.path)}`;
      const artifactPoint = childPosition(taskNode, artifactIndex, outward, 19);
      nodes.push(pinned(id, artifact.name, 'artifact', artifactPoint.x, artifactPoint.y, artifact.type));
      links.push({ source: `task:${task.id}`, target: id });
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
