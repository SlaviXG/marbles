import type { Note } from "./types";
import type { AgentInfo, AgentTask } from "./agentTypes";

export interface GNode {
  id: string;
  label: string;
  type: "note" | "section" | "url" | "agent" | "task" | "artifact";
  artifactType?: string;
}

export function composeGraph(notes: Record<string, Note>, agents: AgentInfo[], tasks: AgentTask[]) {
  const graph = buildGraph(notes);
  const nodes = [...graph.nodes];
  const links = [...graph.links];
  for (const agent of agents) nodes.push({ id: `agent:${agent.instanceName}`, label: agent.instanceName, type: 'agent' });
  for (const task of tasks.slice(0, 30)) {
    nodes.push({ id: `task:${task.id}`, label: task.prompt.slice(0, 48), type: 'task' });
    links.push({ source: `agent:${task.agentId}`, target: `task:${task.id}` });
    for (const artifact of task.artifacts) {
      const id = `artifact:${task.id}:${encodeURIComponent(artifact.path)}`;
      nodes.push({ id, label: artifact.name, type: 'artifact', artifactType: artifact.type });
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
