import { describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../agents/AgentRegistry.mjs';

const agent = (id, path = `/bin/${id}`) => ({ id, name: id, path, kind: 'cli', available: true, codingAgent: true });

describe('live agent registry', () => {
  it('emits add, change, and removal diffs by provider ID', async () => {
    const scans = [[agent('codex')], [agent('codex'), agent('claude')], [agent('codex', '/opt/codex')], []];
    const registry = new AgentRegistry({ detector: vi.fn(async () => scans.shift()) });
    const events = [];
    registry.onChange(event => events.push(event));
    await registry.refresh();
    await registry.refresh();
    await registry.refresh();
    await registry.refresh();
    expect(events.map(({ type, agent: found, id }) => [type, found?.id ?? id])).toEqual([
      ['added', 'codex'], ['added', 'claude'], ['changed', 'codex'], ['removed', 'claude'], ['removed', 'codex'],
    ]);
    expect(registry.snapshot()).toEqual([]);
  });

  it('shares an in-flight scan and never overlaps interval scans', async () => {
    let finish;
    const detector = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const registry = new AgentRegistry({ detector, intervalMs: 10 });
    const first = registry.refresh();
    await Promise.resolve();
    expect(registry.refresh()).toBe(first);
    registry.start();
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(detector).toHaveBeenCalledTimes(1);
    registry.stop();
    finish([agent('codex')]);
    await first;
    expect(registry.snapshot().map(a => a.id)).toEqual(['codex']);
  });
});
