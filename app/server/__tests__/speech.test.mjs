import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { speechHandler } from '../transport/speech.mjs';
import { SPEECH_VOICES } from '../../shared/speechVoices.mjs';

class Response extends EventEmitter {
  code = 200; data = null; headers = {};
  set(key, value) { this.headers[key] = value; return this; }
  status(code) { this.code = code; return this; }
  type(type) { this.contentType = type; return this; }
  json(data) { this.data = data; return this; }
  send(data) { this.data = data; this.writableEnded = true; return this; }
}
const request = text => ({ headers: { origin: 'http://localhost:5173' }, body: { text } });

describe('speech synthesis', () => {
  it('keeps the key upstream and returns audio with no caching', async () => {
    const fetchApi = vi.fn(async () => ({ ok: true, body: [Buffer.from('audio')] }));
    const res = new Response();
    await speechHandler({ apiKey: 'test-key', fetchApi })(request('Done.'), res);
    expect(res.code).toBe(200);
    expect(res.contentType).toBe('audio/mpeg');
    expect(res.data.toString()).toBe('audio');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(fetchApi.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Done.', response_format: 'mp3' });
  });
  it.each(SPEECH_VOICES)('passes the selected %s voice upstream', async voice => {
    const fetchApi = vi.fn(async () => ({ ok: true, body: [Buffer.from('audio')] }));
    const req = request('Hello.'); req.body.voice = voice;
    const res = new Response();
    await speechHandler({ apiKey: 'test', fetchApi })(req, res);
    expect(res.code).toBe(200);
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).voice).toBe(voice);
  });
  it.each(['unknown', '', null, { id: 'custom' }])('rejects unsupported voice %j before calling OpenAI', async voice => {
    const fetchApi = vi.fn();
    const req = request('Hello.'); req.body.voice = voice;
    const res = new Response();
    await speechHandler({ apiKey: 'test', fetchApi })(req, res);
    expect(res.code).toBe(400);
    expect(fetchApi).not.toHaveBeenCalled();
  });
  it('rejects untrusted origins, oversized text, and missing keys', async () => {
    const fetchApi = vi.fn();
    const handler = speechHandler({ apiKey: 'test', fetchApi });
    const remote = new Response();
    await handler({ ...request('test'), headers: { origin: 'https://evil.example' } }, remote);
    expect(remote.code).toBe(403);
    const long = new Response(); await handler(request('x'.repeat(2001)), long);
    expect(long.code).toBe(400);
    const missing = new Response(); await speechHandler({ apiKey: '', fetchApi })(request('test'), missing);
    expect(missing.code).toBe(503);
    expect(fetchApi).not.toHaveBeenCalled();
  });
  it('sanitizes API errors', async () => {
    const res = new Response();
    await speechHandler({ apiKey: 'secret', fetchApi: async () => { throw new Error('secret'); } })(request('test'), res);
    expect(res.code).toBe(502);
    expect(JSON.stringify(res.data)).not.toContain('secret');
  });
  it('aborts provider work when the browser disconnects', async () => {
    const res = new Response();
    let signal;
    const fetchApi = vi.fn(async (_url, options) => {
      signal = options.signal;
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const work = speechHandler({ apiKey: 'test', fetchApi })(request('test'), res);
    res.emit('close'); await work;
    expect(signal.aborted).toBe(true);
  });
});
