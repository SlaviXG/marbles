import { describe, it, expect } from "vitest";
import { buildGraph } from "../core/graph";
import { notes } from "./fixtures";

describe("buildGraph", () => {
  const { nodes, links } = buildGraph(notes);

  it("creates a node per note, section, and url", () => {
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toContain("a.md");
    expect(ids).toContain("b.md");
    expect(ids).toContain("a.md#s1");
    expect(ids).toContain("https://example.com/x");
  });

  it("links note -> section and section -> url", () => {
    expect(links).toContainEqual({ source: "a.md", target: "a.md#s1" });
    expect(links).toContainEqual({ source: "a.md#s1", target: "https://example.com/x" });
  });

  it("resolves a [[wikilink]] to the target note", () => {
    expect(links).toContainEqual({ source: "a.md", target: "b.md" });
  });
});

import { composeGraph } from '../core/graph';

describe('agent canvas mapping', () => {
  const agent = (id: string, codingAgent: boolean) => ({
    id, name: id, kind: 'cli' as const,
    command: id, path: `/bin/${id}`, version: null, available: true, codingAgent,
  });
  const task = { id: 't1', agentId: 'codex', prompt: 'make file', status: 'completed' as const,
    createdAt: '', updatedAt: '', stdout: '', stderr: '', artifacts: [{ path: 'codex/t1/out.pdf', name: 'out.pdf', type: 'pdf' as const }] };

  it('starts with coding agents only, clustered near the center', () => {
    const graph = composeGraph(notes, [agent('cursor', true), agent('openclaw', false), agent('codex', true), agent('claude', true)], []);
    expect(graph.nodes.map(n => n.id)).toEqual(['agent:claude', 'agent:codex', 'agent:cursor']);
    expect(graph.links).toEqual([]);
    for (const node of graph.nodes) {
      expect(Math.hypot(node.x!, node.y!)).toBeLessThanOrEqual(42.1);
      expect([node.fx, node.fy]).toEqual([node.x, node.y]);
    }
  });

  it('adds a task and only its generated files close to their parents', () => {
    const graph = composeGraph(notes, [agent('codex', true), agent('openclaw', false)], [task]);
    const agentNode = graph.nodes.find(n => n.id === 'agent:codex')!;
    const taskNode = graph.nodes.find(n => n.id === 'task:t1')!;
    const artifactNode = graph.nodes.find(n => n.type === 'artifact')!;
    expect(taskNode).toMatchObject({ label: 'make file', type: 'task' });
    expect(artifactNode).toMatchObject({ label: 'out.pdf', type: 'artifact', artifactType: 'pdf' });
    expect(graph.links).toContainEqual({ source: 'agent:codex', target: 'task:t1' });
    expect(graph.links).toContainEqual({ source: 'task:t1', target: `artifact:t1:${encodeURIComponent('codex/t1/out.pdf')}` });
    expect(Math.hypot(taskNode.x! - agentNode.x!, taskNode.y! - agentNode.y!)).toBeLessThanOrEqual(25);
    expect(Math.hypot(artifactNode.x! - taskNode.x!, artifactNode.y! - taskNode.y!)).toBeLessThanOrEqual(20);
    expect(graph.nodes.filter(n => n.type === 'agent')).toHaveLength(1);
  });

  it('keeps the vault graph available behind the flag', () => {
    expect(composeGraph(notes, [], [], true).nodes.some(n => n.type === 'note')).toBe(true);
  });

  it('omits tasks belonging to agents filtered from the canvas', () => {
    const hidden = { ...task, agentId: 'openclaw' };
    expect(composeGraph(notes, [agent('openclaw', false)], [hidden]).nodes).toEqual([]);
  });

  it('keeps an existing agent in place as other agents appear or disappear', () => {
    const codex = agent('codex', true);
    const alone = composeGraph(notes, [codex], []).nodes[0];
    const together = composeGraph(notes, [codex, agent('claude', true), agent('cursor', true)], []);
    expect(together.nodes.find(n => n.id === 'agent:codex')).toMatchObject({ x: alone.x, y: alone.y });
    const unavailable = composeGraph(notes, [{ ...codex, available: false }], [task]);
    expect(unavailable.nodes.find(n => n.id === 'agent:codex')).toMatchObject({ available: false });
    expect(unavailable.nodes.map(n => n.id)).toContain('task:t1');
  });
});
