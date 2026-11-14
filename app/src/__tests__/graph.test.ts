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
  it('maps detected agents independently of notes and links tasks and files', () => {
    const graph = composeGraph(notes, [{ id: 'codex', instanceName: 'pushkar-codex', name: 'Codex', kind: 'cli', command: 'codex', path: '/bin/codex', version: null, available: true }], [{ id: 't1', agentId: 'pushkar-codex', prompt: 'make file', status: 'completed', createdAt: '', updatedAt: '', stdout: '', stderr: '', artifacts: [{ path: 'pushkar-codex/t1/out.pdf', name: 'out.pdf', type: 'pdf' }] }]);
    expect(graph.nodes).toContainEqual({ id: 'agent:pushkar-codex', label: 'pushkar-codex', type: 'agent' });
    expect(graph.nodes).toContainEqual({ id: 'task:t1', label: 'make file', type: 'task' });
    expect(graph.nodes).toContainEqual({ id: `artifact:t1:${encodeURIComponent('pushkar-codex/t1/out.pdf')}`, label: 'out.pdf', type: 'artifact', artifactType: 'pdf' });
    expect(graph.links).toContainEqual({ source: 'agent:pushkar-codex', target: 'task:t1' });
    expect(graph.links).toContainEqual({ source: 'task:t1', target: `artifact:t1:${encodeURIComponent('pushkar-codex/t1/out.pdf')}` });
    expect(graph.nodes.filter(n => n.type === 'agent')).toHaveLength(1);
  });
});
