import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { speechHandler } from '../transport/speech.mjs';
import { elevenLabsTts } from '../transport/ttsProviders.mjs';
import { createApp } from '../transport/createApp.mjs';
import { SPEECH_VOICES } from '../../shared/speechVoices.mjs';

class Response extends EventEmitter {
  code = 200; data = null; headers = {}; chunks = []; headersSent = false;
  set(key, value) { this.headers[key] = value; return this; }
  status(code) { this.code = code; return this; }
  type(type) { this.contentType = type; return this; }
  json(data) { this.data = data; return this; }
  write(data) { this.headersSent = true; this.chunks.push(Buffer.from(data)); return true; }
  end() { this.data = Buffer.concat(this.chunks); this.writableEnded = true; return this; }
  send(data) { this.data = data; this.writableEnded = true; return this; }
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}
const request = text => ({ headers: { origin: 'http://localhost:5173' }, body: { text } });
const audio = (...chunks) => ({ ok: true, body: chunks.map(chunk => Buffer.from(chunk)) });

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('speech synthesis', () => {
  it('keeps the key upstream and returns audio with no caching', async () => {
    const fetchApi = vi.fn(async () => audio('audio'));
    const res = new Response();
    await speechHandler({ apiKey: 'test-key', elevenLabsApiKey: '', fetchApi })(request('Done.'), res);
    expect(res.code).toBe(200);
    expect(res.contentType).toBe('audio/mpeg');
    expect(res.data.toString()).toBe('audio');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['X-TTS-Provider']).toBe('openai');
    expect(fetchApi.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-4o-mini-tts', voice: 'marin', input: 'Done.', response_format: 'mp3' });
  });
  it.each(SPEECH_VOICES)('passes the selected %s voice upstream', async voice => {
    const fetchApi = vi.fn(async () => audio('audio'));
    const req = request('Hello.'); req.body.voice = voice;
    const res = new Response();
    await speechHandler({ apiKey: 'test', elevenLabsApiKey: '', fetchApi })(req, res);
    expect(res.code).toBe(200);
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).voice).toBe(voice);
  });
  it.each(['unknown', '', null, { id: 'custom' }])('rejects unsupported voice %j before calling OpenAI', async voice => {
    const fetchApi = vi.fn();
    const req = request('Hello.'); req.body.voice = voice;
    const res = new Response();
    await speechHandler({ apiKey: 'test', elevenLabsApiKey: '', fetchApi })(req, res);
    expect(res.code).toBe(400);
    expect(fetchApi).not.toHaveBeenCalled();
  });
  it('rejects untrusted origins, oversized text, and missing keys', async () => {
    const fetchApi = vi.fn();
    const handler = speechHandler({ apiKey: 'test', elevenLabsApiKey: '', fetchApi });
    const remote = new Response();
    await handler({ ...request('test'), headers: { origin: 'https://evil.example' } }, remote);
    expect(remote.code).toBe(403);
    const long = new Response(); await handler(request('x'.repeat(2001)), long);
    expect(long.code).toBe(400);
    const missing = new Response(); await speechHandler({ apiKey: '', elevenLabsApiKey: '', fetchApi })(request('test'), missing);
    expect(missing.code).toBe(503);
    expect(missing.data.error).toContain('ELEVENLABS_API_KEY');
    expect(fetchApi).not.toHaveBeenCalled();
  });
  it('sanitizes API errors', async () => {
    const res = new Response();
    await speechHandler({ apiKey: 'secret', elevenLabsApiKey: '', fetchApi: async () => { throw new Error('secret'); } })(request('test'), res);
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
    const work = speechHandler({ apiKey: 'test', elevenLabsApiKey: '', fetchApi })(request('test'), res);
    res.emit('close'); await work;
    expect(signal.aborted).toBe(true);
  });

  it('streams ElevenLabs audio with its voice and model, before the stream finishes', async () => {
    let release;
    const fetchApi = vi.fn(async () => ({ ok: true, body: (async function* () {
      yield Buffer.from('first');
      await new Promise(resolve => { release = resolve; });
      yield Buffer.from('second');
    })() }));
    const res = new Response();
    const work = speechHandler({ apiKey: 'openai-secret', elevenLabsApiKey: 'eleven-secret',
      voiceId: 'CustomVoice123', modelId: 'test_model', fetchApi })(request('Hello'), res);
    await vi.waitFor(() => expect(res.chunks).toHaveLength(1));
    expect(res.writableEnded).not.toBe(true);
    expect(res.headers['X-TTS-Provider']).toBe('elevenlabs');
    expect(fetchApi.mock.calls[0][0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/CustomVoice123/stream?output_format=mp3_44100_128');
    expect(fetchApi.mock.calls[0][1].headers).toMatchObject({ 'xi-api-key': 'eleven-secret', 'Content-Type': 'application/json', Accept: 'audio/mpeg' });
    expect(JSON.parse(fetchApi.mock.calls[0][1].body)).toEqual({ text: 'Hello', model_id: 'test_model' });
    release(); await work;
    expect(res.data.toString()).toBe('firstsecond');
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^\[tts\] provider=elevenlabs voice=CustomVoice123 model=test_model ms=\d+$/));
  });

  it('uses the default ElevenLabs voice and environment overrides', async () => {
    vi.stubEnv('ELEVENLABS_VOICE_ID', ''); vi.stubEnv('ELEVENLABS_MODEL_ID', '');
    let fetchApi = vi.fn(async () => audio('mp3'));
    await elevenLabsTts({ text: 'Hello', apiKey: 'key', fetchApi });
    expect(fetchApi.mock.calls[0][0]).toContain('/DODLEQrClDo8wCz460ld/stream');
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).model_id).toBe('eleven_flash_v2_5');
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'OverriddenVoice123'); vi.stubEnv('ELEVENLABS_MODEL_ID', 'other_model');
    fetchApi = vi.fn(async () => audio('mp3'));
    await elevenLabsTts({ text: 'Hello', apiKey: 'key', fetchApi });
    expect(fetchApi.mock.calls[0][0]).toContain('/OverriddenVoice123/stream');
    expect(JSON.parse(fetchApi.mock.calls[0][1].body).model_id).toBe('other_model');
  });

  it('rejects an invalid ElevenLabs voice ID without sending a request', async () => {
    const fetchApi = vi.fn();
    await expect(elevenLabsTts({ text: 'Hello', apiKey: 'key', voiceId: '../bad', fetchApi })).rejects.toThrow('Invalid ElevenLabs voice ID');
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it.each([
    ['401', async () => ({ ok: false, status: 401 })],
    ['500', async () => ({ ok: false, status: 500 })],
    ['network error', async () => { throw new Error('private-key'); }],
    ['empty body', async () => ({ ok: true, body: [] })],
    ['missing body', async () => ({ ok: true, body: null })],
  ])('falls back to OpenAI after ElevenLabs %s', async (_reason, firstResponse) => {
    const fetchApi = vi.fn().mockImplementationOnce(firstResponse).mockImplementationOnce(async () => audio('fallback'));
    const req = request('Hello'); req.body.voice = 'cedar';
    const res = new Response();
    await speechHandler({ apiKey: 'openai-secret', elevenLabsApiKey: 'eleven-secret', fetchApi })(req, res);
    expect(res.code).toBe(200);
    expect(res.data.toString()).toBe('fallback');
    expect(res.headers['X-TTS-Provider']).toBe('openai');
    expect(fetchApi.mock.calls[1][0]).toBe('https://api.openai.com/v1/audio/speech');
    expect(JSON.parse(fetchApi.mock.calls[1][1].body).voice).toBe('cedar');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(console.log.mock.calls)).not.toMatch(/secret|private-key|Hello/);
  });

  it('falls back to OpenAI when the ElevenLabs key is missing', async () => {
    const fetchApi = vi.fn(async () => audio('fallback'));
    const res = new Response();
    await speechHandler({ apiKey: 'openai-secret', elevenLabsApiKey: '', fetchApi })(request('Hello'), res);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(res.headers['X-TTS-Provider']).toBe('openai');
    expect(console.log).toHaveBeenCalledWith('[tts] provider=openai fallback=missing_key');
  });

  it('falls back to OpenAI after an ElevenLabs timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchApi = vi.fn().mockImplementationOnce(async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })).mockImplementationOnce(async () => audio('fallback'));
      const res = new Response();
      const work = speechHandler({ apiKey: 'openai-key', elevenLabsApiKey: 'eleven-key', fetchApi })(request('Hello'), res);
      await vi.advanceTimersByTimeAsync(25_000);
      await work;
      expect(res.data.toString()).toBe('fallback');
      expect(console.log).toHaveBeenCalledWith('[tts] provider=openai fallback=timeout');
    } finally { vi.useRealTimers(); }
  });

  it('keeps the 4 MB cap when streaming ElevenLabs audio', async () => {
    const fetchApi = vi.fn(async () => ({ ok: true, body: [Buffer.from('first'), Buffer.alloc(4 * 1024 * 1024)] }));
    const res = new Response();
    await speechHandler({ apiKey: 'openai-key', elevenLabsApiKey: 'eleven-key', fetchApi })(request('Hello'), res);
    expect(res.destroyed).toBe(true);
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it('reports provider configuration through the tts-info route without secrets', async () => {
    const app = createApp({ snapshot: () => ({}), onChange: () => () => {} }, {
      agentRegistry: { snapshot: () => [] }, taskService: { snapshot: () => [], isBusy: () => false, root: '/tmp' },
      swarmService: { snapshot: () => [], isBusy: () => false }, voiceCommands: { dispatch: vi.fn() },
    });
    const route = app._router.stack.find(layer => layer.route?.path === '/api/voice/tts-info').route.stack[0].handle;
    for (const [eleven, openai, provider] of [['eleven-secret', 'openai-secret', 'elevenlabs'], ['', 'openai-secret', 'openai'], ['', '', 'none']]) {
      vi.stubEnv('ELEVENLABS_API_KEY', eleven); vi.stubEnv('OPENAI_API_KEY', openai);
      const res = { json(value) { this.data = value; return this; } };
      route({}, res);
      expect(res.data).toMatchObject({ provider, voiceId: expect.any(String), model: expect.any(String) });
      expect(JSON.stringify(res.data)).not.toMatch(/secret/);
    }
  });
});
