import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../transport/createApp.mjs';

describe('embedded artifact resources', () => {
  it('serves relative preview resources from the workspace and rejects traversal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'marbles-preview-'));
    try {
      await mkdir(path.join(root, 'task'));
      await writeFile(path.join(root, 'task', 'style.css'), 'body{color:navy}');
      const service = { snapshot: () => ({ notes: [] }), onChange: () => () => {} };
      const app = createApp(service, { agentRegistry: { snapshot: () => [] }, taskService: { root, isBusy: () => false }, swarmService: { isBusy: () => false } });
      const handler = app._router.stack.find(layer => layer.route?.path === '/api/artifacts/view/*').route.stack[0].handle;
      const response = () => ({ code: 200, headers: {}, file: null, body: null, set(name,value) { this.headers[name]=value; return this; }, sendFile(file) { this.file=file; }, status(code) { this.code=code; return this; }, json(body) { this.body=body; } });
      const valid = response(); await handler({ params: { 0: 'task/style.css' } }, valid);
      expect(valid.file).toBe(await realpath(path.join(root, 'task', 'style.css')));
      expect(valid.headers['Content-Security-Policy']).toContain("script-src 'none'");
      const outside = response(); await handler({ params: { 0: '../outside.html' } }, outside);
      expect(outside.code).toBe(400); expect(outside.file).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
