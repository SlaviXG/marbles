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

import { composeGraph, isCanvasArtifact } from '../core/graph';

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

  it('surfaces important files directly under their agent without task clutter', () => {
    const graph = composeGraph(notes, [agent('codex', true)], [task]);
    const parent = graph.nodes.find(n => n.id === 'agent:codex')!;
    const artifact = graph.nodes.find(n => n.type === 'artifact')!;
    expect(graph.nodes.some(n => n.type === 'task')).toBe(false);
    expect(artifact).toMatchObject({ label: 'out.pdf', type: 'artifact', artifactType: 'pdf' });
    expect(graph.links).toContainEqual({ source: 'agent:codex', target: `artifact:t1:${encodeURIComponent('codex/t1/out.pdf')}` });
    expect(Math.hypot(artifact.x! - parent.x!, artifact.y! - parent.y!)).toBeLessThanOrEqual(37);
  });

  it('filters source/dependency clutter and caps the recent deliverables', () => {
    for (const name of ['report.md', 'budget.xlsx', 'proposal.docx', 'deck.pptx', 'chart.png']) {
      expect(isCanvasArtifact({ name, path: `codex/t1/${name}`, type: 'other' })).toBe(true);
    }
    for (const name of ['index.ts', 'package.json', 'AGENTS.md', 'CLAUDE.md']) {
      expect(isCanvasArtifact({ name, path: `codex/t1/${name}`, type: 'code' })).toBe(false);
    }
    expect(isCanvasArtifact({ name: 'README.md', path: 'codex/t1/node_modules/lib/README.md', type: 'code' })).toBe(false);
    const files = Array.from({ length: 30 }, (_, i) => ({ name: `${i}.md`, path: `codex/t1/${i}.md`, type: 'code' as const }));
    const graph = composeGraph(notes, [agent('codex', true)], [{ ...task, artifacts: files }]);
    expect(graph.nodes.filter(n => n.type === 'artifact')).toHaveLength(18);
    expect(graph.nodes.find(n => n.type === 'artifact')?.artifactType).toBe('markdown');
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
    expect(unavailable.nodes.some(n => n.type === 'artifact')).toBe(true);
  });
});
