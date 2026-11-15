import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { liveEnv } from '../env.mjs';
import { resolveArtifact } from '../agents/taskService.mjs';
import { isEmail } from './comms.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const RETRY_WINDOW = 55 * 60 * 1000; // Nylas keeps idempotency keys for one hour.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const html = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]).replace(/\r?\n/g, '<br>');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function emailProvider(env = liveEnv) {
  return env('MARBLES_EMAIL_VIA') || (env('NYLAS_API_KEY') || env('NYLAS_GRANT_ID') ? 'nylas' : 'agent');
}

export function nylasConfig(env = liveEnv) {
  const apiKey = env('NYLAS_API_KEY')?.trim();
  const grantId = env('NYLAS_GRANT_ID')?.trim();
  const apiUri = (env('NYLAS_API_URI') || 'https://api.us.nylas.com').replace(/\/$/, '');
  if (!apiKey || !grantId) throw fail('Email is not connected yet. Add NYLAS_API_KEY and NYLAS_GRANT_ID to the server’s .env.', 503);
  if (!['https://api.us.nylas.com', 'https://api.eu.nylas.com'].includes(apiUri)) throw fail('NYLAS_API_URI must be the Nylas US or EU API address.', 503);
  return { apiKey, grantId, apiUri };
}

/** Local drafts bind confirmation to the exact recipients, text and files shown.
 * Credentials and attachment bytes never enter a model prompt or browser state.
 * No worker or Mail fallback runs after a Nylas attempt: a timeout may have sent.
 */
export class NylasEmail {
  constructor({ root, artifacts = () => [], env = liveEnv, fetchImpl = fetch, now = Date.now } = {}) {
    Object.assign(this, { root, artifacts, env, fetchImpl, now });
    this.drafts = new Map();
  }
  async attachment(relative) {
    if (typeof relative !== 'string' || !this.artifacts().some(file => file.path === relative)) throw fail('That attachment is not a generated workspace asset.');
    const full = await resolveArtifact(this.root, relative);
    const size = (await stat(full)).size;
    if (size > MAX_BYTES) throw fail('Attachments must total less than 20 MB.');
    const bytes = await readFile(full);
    if (bytes.length > MAX_BYTES) throw fail('Attachments must total less than 20 MB.');
    return { path: relative, name: path.basename(full), size: bytes.length, digest: hash(bytes), bytes };
  }
  async prepare({ to, name = '', subject, body, attachments = [] }) {
    if (!isEmail(to) || typeof subject !== 'string' || !subject.trim() || subject.length > 200 || typeof body !== 'string' || !body.trim() || body.length > 8000) throw fail('A valid recipient, subject and message are required.');
    if (!Array.isArray(attachments) || attachments.length > 10 || new Set(attachments).size !== attachments.length) throw fail('Choose up to 10 different attachments.');
    const files = [];
    let total = 0;
    for (const relative of attachments) {
      const { bytes, ...file } = await this.attachment(relative);
      total += bytes.length;
      if (total > MAX_BYTES) throw fail('Attachments must total less than 20 MB.');
      files.push(file);
    }
    // Expired previews can be discarded; keep send receipts to prevent replay.
    for (const [id, draft] of this.drafts) {
      if (!draft.startedAt && this.now() - draft.createdAt > RETRY_WINDOW) this.drafts.delete(id);
      else if (!draft.sending && draft.startedAt && this.now() - draft.startedAt > RETRY_WINDOW) draft.payload = null;
    }
    if (this.drafts.size >= 200) throw fail('The email session is full. Restart Marbles before preparing more messages.', 503);
    const draftId = randomUUID();
    const display = { kind: 'email', draftId, to: to.trim(), name, subject: subject.trim(), body: body.trim(),
      attachments: files.map(({ path, name, size }) => ({ path, name, size })) };
    this.drafts.set(draftId, { display, files, createdAt: this.now(), startedAt: null, result: null, sending: null });
    return structuredClone(display);
  }
  send(draftId) {
    const draft = this.drafts.get(draftId);
    if (!draft) return Promise.reject(fail('This email preview expired. Ask Marbles to prepare it again.'));
    if (draft.result) return Promise.resolve(draft.result);
    if (draft.sending) return draft.sending;
    if (this.now() - (draft.startedAt ?? draft.createdAt) > RETRY_WINDOW) return Promise.reject(fail('This email preview expired. Check Sent mail before preparing it again.'));
    draft.sending = this.deliver(draftId, draft).finally(() => { draft.sending = null; });
    return draft.sending;
  }
  async deliver(draftId, draft) {
    const config = nylasConfig(this.env);
    const identity = `${config.apiUri}/${config.grantId}`;
    if (draft.identity && draft.identity !== identity) throw fail('The sending account changed. Check Sent mail and prepare a new preview.');
    const files = [];
    for (const original of draft.files) {
      let current;
      try { current = await this.attachment(original.path); }
      catch { throw fail('An attachment is no longer available. Ask Marbles to prepare a new preview.'); }
      if (current.digest !== original.digest || current.name !== original.name) throw fail('An attachment changed after this preview. Ask Marbles to prepare a new preview.');
      files.push(current);
    }
    const message = { to: [{ email: draft.display.to }], subject: draft.display.subject, body: html(draft.display.body) };
    const headers = { Authorization: `Bearer ${config.apiKey}`, 'Idempotency-Key': draftId, Accept: 'application/json' };
    let body;
    if (files.length) {
      if (!draft.payload) {
        const retained = [...this.drafts.values()].reduce((sum, item) => sum + (item.payload?.body.length ?? 0), 0);
        if (retained + files.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) throw fail('Too many attachments are awaiting delivery. Settle the earlier emails first.', 503);
        const form = new FormData();
        form.append('message', JSON.stringify(message));
        files.forEach((file, i) => form.append(`file${i}`, new Blob([file.bytes], { type: 'application/octet-stream' }), file.name));
        // Serialize once, including the boundary, so retries have identical bytes.
        const encoded = new Request(config.apiUri, { method: 'POST', body: form });
        draft.payload = { body: Buffer.from(await encoded.arrayBuffer()), type: encoded.headers.get('Content-Type') };
      }
      body = draft.payload.body;
      headers['Content-Type'] = draft.payload.type;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(message);
    }
    draft.startedAt ??= this.now();
    draft.identity = identity;
    let response;
    try {
      response = await this.fetchImpl(`${config.apiUri}/v3/grants/${encodeURIComponent(config.grantId)}/messages/send`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(25_000), redirect: 'error',
      });
    } catch { throw fail('Email delivery is not confirmed. Try again from this preview to check the same send safely; do not create another email.', 502); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw fail('Nylas refused email access. Check the API key and Gmail sending permission, then prepare a new preview.', 503);
      if (response.status === 429) throw fail('Nylas is limiting email requests. Wait, then prepare a new preview.', 429);
      if (response.status >= 500 || response.status === 409) throw fail('Email delivery is not confirmed. Retry this preview, or check Sent mail before preparing another email.', 502);
      throw fail('Nylas rejected this email. Check the recipient and attachments, then prepare a new preview.');
    }
    let receipt;
    try { receipt = await response.json(); } catch { /* A response without an ID is not a confirmed send. */ }
    if (typeof receipt?.data?.id !== 'string' || !receipt.data.id) throw fail('Nylas did not confirm delivery. Retry this preview to check the same send safely.', 502);
    draft.payload = null;
    return draft.result = { sent: true, via: 'Nylas', messageId: receipt.data.id };
  }
}
