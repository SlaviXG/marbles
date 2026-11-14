import { expect, it, vi } from 'vitest';
import { createApp } from '../transport/createApp.mjs';

const service = { snapshot: () => ({ notes: [] }) };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function setup() {
  const dispatch = vi.fn(async () => ({ state: 'assigned', task: { id: 'task-123' }, reply: 'Codex is on it.' }));
  const summarize = vi.fn(async () => ({ reply: 'The plan is ready.' }));
  const app = createApp(service, { agentRegistry: { snapshot: () => [] }, taskService: { root: '/tmp' }, swarmService: {}, voiceCommands: { dispatch, summarize } });
  const route = path => app._router.stack.find(layer => layer.route?.path === path).route.stack[0].handle;
  return { dispatch, summarize, route };
}
it('protects coordinator and summary endpoints with the local origin check', async () => {
  const { route, dispatch, summarize } = setup();
  for (const path of ['/api/voice/tasks', '/api/voice/result']) {
    const res = response(); await route(path)({ headers: { origin: 'https://example.com' }, body: {} }, res);
    expect(res.statusCode).toBe(403);
  }
  expect(dispatch).not.toHaveBeenCalled(); expect(summarize).not.toHaveBeenCalled();
});
it('returns accepted work and actionable configuration errors', async () => {
  const { route, dispatch } = setup();
  const req = { headers: { origin: 'http://localhost:5173' }, body: { requestId: 'request-123' } };
  let res = response(); await route('/api/voice/tasks')(req, res);
  expect(res.statusCode).toBe(202); expect(res.body.reply).toBe('Codex is on it.');
  dispatch.mockRejectedValueOnce(Object.assign(new Error('Add ANTHROPIC_API_KEY'), { code: 'COORDINATOR_CONFIG' }));
  res = response(); await route('/api/voice/tasks')(req, res);
  expect(res.statusCode).toBe(503); expect(res.body.error).toContain('ANTHROPIC_API_KEY');
});
