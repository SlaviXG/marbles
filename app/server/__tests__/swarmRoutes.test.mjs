import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../transport/createApp.mjs';

function route(app, method, path) {
  return app._router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route.stack[0].handle;
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
const service = { snapshot: () => ({ notes: [] }), onChange: () => () => {} };
const registry = { snapshot: () => [] };
const taskService = { root: '/tmp', isBusy: () => false, snapshot: () => [] };

describe('swarm routes', () => {
  it('returns validation errors and 404s as JSON', async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error('Enter a goal under 6,000 characters')).mockRejectedValueOnce(new Error('Cursor CLI not installed'));
    const swarmService = { start, snapshot: () => [], statsSnapshot: () => ({ agents: {} }), get: () => null, cancel: () => null, isBusy: () => false };
    const app = createApp(service, { agentRegistry: registry, taskService, swarmService });
    let res = response(); await route(app, 'post', '/api/swarm/tasks')({ body: { goal: '' } }, res);
    expect(res.statusCode).toBe(400); expect(res.body.error).toContain('goal');
    res = response(); await route(app, 'post', '/api/swarm/tasks')({ body: { goal: 'x', agents: ['cursor'] } }, res);
    expect(res.statusCode).toBe(400); expect(res.body.error).toContain('not installed');
    res = response(); route(app, 'get', '/api/swarm/tasks/:id')({ params: { id: 'missing' } }, res);
    expect(res.statusCode).toBe(404);
  });
});
