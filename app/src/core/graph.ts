import type { Note } from "./types";
import type { AgentInfo, AgentTask, ArtifactInfo, SwarmTask } from "./agentTypes";

export interface GNode {
  id: string;
  label: string;
  type: "note" | "section" | "url" | "agent" | "task" | "artifact" | "swarm" | "post";
  artifactType?: string;
  available?: boolean;
  status?: 'idle' | 'running' | 'unavailable';
  progress?: string;
  activity?: 'waiting' | 'working' | 'done' | 'failed' | 'unavailable';
  activityKey?: string;
  artifactCount?: number;
  artifactReady?: boolean;
  x?: number;
  y?: number;
  fx?: number;
  fy?: number;
}

const AGENT_RADIUS = 190;
const AGENT_ANGLES: Record<string, number> = { claude: -Math.PI / 2, codex: Math.PI / 6, cursor: 5 * Math.PI / 6 };

function pinned(id: string, label: string, type: GNode["type"], x: number, y: number, artifactType?: string): GNode {
  return { id, label, type, x, y, fx: x, fy: y, ...(artifactType ? { artifactType } : {}) };
}

function childPosition(parent: GNode, index: number, outward: number, distance: number) {
  const angle = outward + [0, -.75, .75][index % 3];
  const radius = distance + Math.floor(index / 3) * 20;
  return { x: parent.x! + Math.cos(angle) * radius, y: parent.y! + Math.sin(angle) * radius };
}

// Surface deliverables, not implementation files or dependency/build output.
export function isCanvasArtifact(artifact: ArtifactInfo) {
  const parts = artifact.path.replace(/\\/g, '/').split('/');
  if (parts.some(part => part.startsWith('.') || ['node_modules', 'dist', 'build', 'coverage', 'target', 'vendor', '__pycache__', 'venv'].includes(part))) return false;
  if (/^(AGENTS|CLAUDE|SKILL)\.md$/i.test(artifact.name)) return false;
  return /\.(md|markdown|mdx|pdf|doc|docx|odt|rtf|txt|xls|xlsx|ods|csv|tsv|ppt|pptx|odp|html|htm|mp3|wav|ogg|m4a|mp4|webm|mov|png|jpe?g|webp|svg)$/i.test(artifact.name);
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
    const node = pinned(`agent:${agent.id}`, agent.name, 'agent', Math.cos(angle) * AGENT_RADIUS, Math.sin(angle) * AGENT_RADIUS);
    node.available = agent.available;
    node.status = status;
    const latest = tasks.find(task => task.agentId === agent.id && task.status === 'running') ?? tasks.find(task => task.agentId === agent.id);
    node.progress = latest ? `${latest.status === 'completed' ? 'Ready to review' : latest.status === 'failed' ? 'Needs attention' : 'Working'}: ${latest.title || latest.intent?.objective || latest.prompt}` : undefined;
    const latestSwarm = swarms.find(swarm => swarm.agents.includes(agent.id) && ['running', 'evaluating'].includes(swarm.status)) ?? swarms.find(swarm => swarm.agents.includes(agent.id));
    node.activity = status === 'unavailable' ? 'unavailable' : status === 'running' ? 'working' : latestSwarm?.status === 'completed' || latest?.status === 'completed' ? 'done' : latestSwarm?.status === 'failed' || latest?.status === 'failed' ? 'failed' : 'waiting';
    node.activityKey = `${node.activity}:${latestSwarm?.id ?? latest?.id ?? 'idle'}`;
    if (latestSwarm) node.progress = `${node.activity === 'working' ? 'Working' : node.activity === 'done' ? 'Ready to review' : node.activity === 'failed' ? 'Needs attention' : 'Team task'}: ${latestSwarm.goal}`;
    nodes.push(node);
    agentNodes.set(agent.id, node);
  });
  for (const [agentId, parent] of agentNodes) {
    const files = tasks.slice(0, 30).filter(task => task.agentId === agentId)
      .flatMap(task => task.artifacts.filter(isCanvasArtifact).map(artifact => ({ task, artifact })));
    if (!files.length) continue;
    const side = parent.x! < 0 ? -1 : 1;
    const point = { x: parent.x! + side * 90, y: parent.y! - 18 };
    if (files.length > 1) {
      const id = `assets:${agentId}`;
      const ready = files.every(({ task }) => task.status === 'completed');
      const stack = pinned(id, `${files.length} files${ready ? ' ready' : ''}`, 'artifact', point.x, point.y, 'stack');
      stack.artifactReady = ready;
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
    const fileNode = pinned(id, artifact.name, 'artifact', point.x, point.y, format);
    fileNode.artifactReady = task.status === 'completed';
    nodes.push(fileNode);
    links.push({ source: parent.id, target: id });
  }
  for (const [swarmIndex, swarm] of swarms.slice(0, 3).entries()) {
    const x = swarmIndex === 0 ? 0 : swarmIndex === 1 ? -190 : 190;
    const y = swarmIndex === 0 ? 0 : -65;
    const parent = pinned(`swarm:${swarm.id}`, swarm.mode === 'best-of-n' ? 'Compare results' : 'Team task', 'swarm', x, y);
    parent.status = ['running', 'evaluating'].includes(swarm.status) ? 'running' : 'idle';
    parent.activity = parent.status === 'running' ? 'working' : swarm.status === 'completed' ? 'done' : swarm.status === 'failed' ? 'failed' : 'waiting';
    parent.activityKey = `${swarm.id}:${swarm.status}`;
    nodes.push(parent);
    for (const agentId of swarm.agents) if (agentNodes.has(agentId)) links.push({ source: parent.id, target: `agent:${agentId}` });
    for (const [index, post] of (swarm.blackboard ?? []).slice(-3).entries()) {
      const pos = childPosition(parent, index, 0.5, 28);
      const id = `post:${swarm.id}:${post.seq}`;
      nodes.push(pinned(id, `${post.kind}: ${post.text.slice(0, 28)}`, 'post', pos.x, pos.y));
      links.push({ source: parent.id, target: id });
    }
    const sharedFiles = (swarm.artifacts ?? []).filter(isCanvasArtifact);
    if (sharedFiles.length > 1) {
      const id = `assets:swarm:${swarm.id}`;
      const stack = pinned(id, `${sharedFiles.length} shared files`, 'artifact', x + 150, y - 60, 'stack');
      stack.artifactCount = sharedFiles.length;
      stack.artifactReady = swarm.status === 'completed';
      nodes.push(stack); links.push({ source: parent.id, target: id });
    } else if (sharedFiles.length) {
      const artifact = sharedFiles[0];
      const id = `artifact:${swarm.id}:${encodeURIComponent(artifact.path)}`;
      const fileNode = pinned(id, artifact.name, 'artifact', x + 150, y - 60, artifact.type);
      fileNode.artifactReady = swarm.status === 'completed';
      nodes.push(fileNode);
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
