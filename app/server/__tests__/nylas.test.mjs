import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NylasEmail, nylasConfig } from '../comms/nylas.mjs';
import { createApp } from '../transport/createApp.mjs';
import { DisplayTools } from '../agents/DisplayTools.mjs';
import { HermesCoordinator } from '../agents/HermesCoordinator.mjs';
import { launcher } from '../agents/taskService.mjs';
import { VoiceCommands } from '../agents/voiceCommands.mjs';

let root, service, fetchImpl;
const settings = { NYLAS_API_KEY: 'test-secret', NYLAS_GRANT_ID: 'test-grant', NYLAS_API_URI: 'https://api.eu.nylas.com' };
const email = { to: 'sam@example.com', subject: 'The deck', body: 'Here it is.\nA < B & C.' };
const artifacts = [{ path: 'deck.pptx', name: 'deck.pptx' }, { path: 'escape.txt', name: 'escape.txt' }];
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'marbles-nylas-test-'));
  await writeFile(path.join(root, 'deck.pptx'), 'test-deck');
  fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: { id: 'message-123' } }) }));
  service = new NylasEmail({ root, artifacts: () => artifacts, env: name => settings[name], fetchImpl });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('prepares a preview without network access, sends the approved text, and deduplicates confirmation', async () => {
  const draft = await service.prepare(email);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(JSON.stringify(draft)).not.toContain('test-secret');
  draft.to = 'changed@example.com'; // Client state cannot change the server draft.
  const results = await Promise.all([service.send(draft.draftId), service.send(draft.draftId)]);
  expect(results[0]).toEqual({ sent: true, via: 'Nylas', messageId: 'message-123' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, request] = fetchImpl.mock.calls[0];
  expect(url).toBe('https://api.eu.nylas.com/v3/grants/test-grant/messages/send');
  expect(request.headers['Idempotency-Key']).toBe(draft.draftId);
  expect(JSON.parse(request.body)).toEqual({ to: [{ email: email.to }], subject: email.subject, body: 'Here it is.<br>A &lt; B &amp; C.' });
  await service.send(draft.draftId);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('attaches the selected bytes and filenames using multipart without exposing bytes in the preview', async () => {
  const draft = await service.prepare({ ...email, attachments: ['deck.pptx'] });
  expect(draft.attachments).toEqual([{ path: 'deck.pptx', name: 'deck.pptx', size: 9 }]);
  await service.send(draft.draftId);
  const request = fetchImpl.mock.calls[0][1];
  const form = await new Response(request.body, { headers: { 'Content-Type': request.headers['Content-Type'] } }).formData();
  expect(form.get('file0').name).toBe('deck.pptx');
  expect(await form.get('file0').text()).toBe('test-deck');
  expect(service.drafts.get(draft.draftId).payload).toBeNull();
});

it('keeps attachment bytes and multipart boundaries identical when retrying an uncertain send', async () => {
  const draft = await service.prepare({ ...email, attachments: ['deck.pptx'] });
  fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  await expect(service.send(draft.draftId)).rejects.toThrow(/not confirmed/);
  await service.send(draft.draftId);
  const first = fetchImpl.mock.calls[0][1], retry = fetchImpl.mock.calls[1][1];
  expect(retry.body.equals(first.body)).toBe(true);
  expect(retry.headers['Content-Type']).toBe(first.headers['Content-Type']);
  expect(retry.headers['Idempotency-Key']).toBe(first.headers['Idempotency-Key']);
});

it('blocks unknown files, traversal, symlink escapes and changed attachments before any send', async () => {
  await expect(service.prepare({ ...email, attachments: ['../private.key'] })).rejects.toThrow(/workspace asset/);
  await symlink('/etc/hosts', path.join(root, 'escape.txt'));
  await expect(service.prepare({ ...email, attachments: ['escape.txt'] })).rejects.toThrow(/Invalid artifact/);
  const draft = await service.prepare({ ...email, attachments: ['deck.pptx'] });
  await writeFile(path.join(root, 'deck.pptx'), 'different contents');
  await expect(service.send(draft.draftId)).rejects.toThrow(/changed after this preview/);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('uses the same idempotency key after an uncertain timeout and never reports it as sent', async () => {
  fetchImpl.mockRejectedValueOnce(new Error('timeout including secret detail'));
  const draft = await service.prepare(email);
  await expect(service.send(draft.draftId)).rejects.toThrow(/not confirmed/);
  expect(service.drafts.get(draft.draftId).result).toBeNull();
  await service.send(draft.draftId);
  expect(fetchImpl.mock.calls.map(([, req]) => req.headers['Idempotency-Key'])).toEqual([draft.draftId, draft.draftId]);
});

it('refuses a retry beyond the provider deduplication window', async () => {
  let now = 1000; service.now = () => now;
  fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  const draft = await service.prepare(email);
  await expect(service.send(draft.draftId)).rejects.toThrow();
  now += 56 * 60 * 1000;
  await expect(service.send(draft.draftId)).rejects.toThrow(/Check Sent/);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('requires a provider receipt and sanitizes provider errors', async () => {
  const draft = await service.prepare(email);
  fetchImpl.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: 'test-secret' } }) });
  await expect(service.send(draft.draftId)).rejects.toThrow(/refused email access/);
  fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ request_id: 'request-only' }) });
  await expect(service.send(draft.draftId)).rejects.toThrow(/did not confirm/);
  expect(service.drafts.get(draft.draftId).result).toBeNull();
});

it('requires configuration and allows keys only to official Nylas API origins', () => {
  expect(() => nylasConfig(() => '')).toThrow(/NYLAS_API_KEY/);
  expect(() => nylasConfig(name => name === 'NYLAS_API_URI' ? 'https://unrelated.example' : settings[name])).toThrow(/US or EU/);
  vi.stubEnv('NYLAS_API_KEY', 'test-secret');
  expect(launcher({ id: 'claude', kind: 'cli', path: 'claude' }, 'make a deck', root).options.env.NYLAS_API_KEY).toBeUndefined();
});

it('sends only server-issued draft IDs from the local confirmation route, without starting workers', async () => {
  vi.stubEnv('MARBLES_EMAIL_VIA', 'nylas');
  const startOrQueue = vi.fn(), mail = vi.fn();
  const app = createApp({ snapshot: () => ({ notes: [] }) }, { taskService: { root, startOrQueue, snapshot: () => [] },
    swarmService: {}, agentRegistry: { snapshot: () => [] }, voiceCommands: {}, comms: { sendEmail: mail }, emailService: service });
  const route = app._router.stack.find(layer => layer.route?.path === '/api/comms/email').route.stack[0].handle;
  const response = () => ({ statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } });
  let res = response();
  await route({ headers: { origin: 'https://outside.example' }, body: email }, res);
  expect(res.statusCode).toBe(403);
  res = response(); await route({ headers: { origin: 'http://localhost:5173' }, body: email }, res);
  expect(res.statusCode).toBe(400); expect(fetchImpl).not.toHaveBeenCalled();
  const draft = await service.prepare(email);
  res = response(); await route({ headers: { origin: 'http://localhost:5173' }, body: { draftId: draft.draftId, to: 'tampered@example.com', via: 'mail' } }, res);
  expect(res.body.sent).toBe(true);
  expect(startOrQueue).not.toHaveBeenCalled(); expect(mail).not.toHaveBeenCalled();
});

it('prepares completed worker deliverables for the original recipient, never sends or trusts a replacement recipient', async () => {
  const record = { id: 'task-1234', source: 'voice', status: 'completed', intent: { email }, artifacts: [artifacts[0]], stdout: 'Finished.' };
  const tasks = { root, snapshot: () => [record] };
  const display = new DisplayTools({ taskService: tasks, prepareEmail: draft => service.prepare(draft) });
  const runner = vi.fn(async (_payload, call) => call('draft_email', { ...email, to: 'wrong@example.com', attachments: ['deck.pptx'] }));
  const coordinator = new HermesCoordinator({ taskService: tasks, display, runner });
  const commands = new VoiceCommands({ taskService: tasks, coordinator });
  const result = await commands.summarize({ id: record.id });
  expect(result.display).toMatchObject({ kind: 'email', to: email.to, attachments: [{ path: 'deck.pptx' }] });
  expect(result.reply).toContain('say send it');
  expect(fetchImpl).not.toHaveBeenCalled();
  await commands.summarize({ id: record.id });
  expect(runner).toHaveBeenCalledTimes(1);
});
