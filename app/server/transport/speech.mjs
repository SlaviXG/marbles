import { localVoiceOrigin } from './voice.mjs';
import { DEFAULT_SPEECH_VOICE, isSpeechVoice } from '../../shared/speechVoices.mjs';
import { DEFAULT_ELEVENLABS_MODEL_ID, DEFAULT_ELEVENLABS_VOICE_ID, elevenLabsTts, openAiTts } from './ttsProviders.mjs';

const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

export function ttsInfo({ elevenLabsApiKey = process.env.ELEVENLABS_API_KEY, apiKey = process.env.OPENAI_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_ELEVENLABS_MODEL_ID } = {}) {
  return { provider: elevenLabsApiKey ? 'elevenlabs' : apiKey ? 'openai' : 'none', voiceId, model: modelId };
}

export function speechHandler({ apiKey = process.env.OPENAI_API_KEY, elevenLabsApiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_ELEVENLABS_MODEL_ID, fetchApi = fetch } = {}) {
  let active = 0;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!localVoiceOrigin(req.headers.origin)) return res.status(403).json({ error: 'Speech playback requires a local app origin.' });
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return res.status(400).json({ error: 'Supply reply text under 2,000 characters.' });
    const voice = req.body?.voice === undefined ? DEFAULT_SPEECH_VOICE : req.body.voice;
    if (!isSpeechVoice(voice)) return res.status(400).json({ error: 'Choose a supported speech voice.' });
    if (!elevenLabsApiKey && !apiKey) {
      console.log('[tts] provider=openai fallback=no_keys');
      return res.status(503).json({ error: 'Set ELEVENLABS_API_KEY or OPENAI_API_KEY and restart the server.' });
    }
    if (active >= 2) return res.status(429).json({ error: 'Speech is busy. Please try again.' });
    active++;
    let currentAbort;
    let closed = false;
    let logged = false;
    const started = Date.now();
    const log = line => { console.log(line); logged = true; };
    const cancel = () => { if (!res.writableEnded) { closed = true; currentAbort?.abort(); } };
    res.on('close', cancel);
    const attempt = async (provider, fallbackReason) => {
      const abort = new AbortController();
      currentAbort = abort;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 25_000);
      try {
        const body = provider === 'elevenlabs'
          ? await elevenLabsTts({ text: text.trim(), apiKey: elevenLabsApiKey, voiceId, modelId, fetchApi, signal: abort.signal })
          : await openAiTts({ text: text.trim(), voice, apiKey, fetchApi, signal: abort.signal });
        const iterator = body?.[Symbol.asyncIterator]?.() ?? body?.[Symbol.iterator]?.();
        if (!iterator) throw new Error('empty_body');
        let first;
        do { first = await iterator.next(); } while (!first.done && !first.value?.length);
        if (first.done) throw new Error('empty_body');
        if (first.value.length > MAX_AUDIO_BYTES) throw new Error('audio_too_large');
        if (closed || abort.signal.aborted) throw new Error('cancelled');
        let size = 0;
        const chunks = [];
        const consume = chunk => {
          size += chunk.length;
          if (size > MAX_AUDIO_BYTES) throw new Error('audio_too_large');
          if (provider === 'elevenlabs') res.write(chunk);
          else chunks.push(Buffer.from(chunk));
        };
        res.set('X-TTS-Provider', provider);
        res.type('audio/mpeg');
        consume(first.value);
        for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
          if (closed || abort.signal.aborted) throw new Error('cancelled');
          if (chunk.length) consume(chunk);
        }
        if (closed || abort.signal.aborted) throw new Error('cancelled');
        if (provider === 'elevenlabs') res.end();
        else res.send(Buffer.concat(chunks));
        if (provider === 'elevenlabs') log(`[tts] provider=elevenlabs voice=${voiceId} model=${modelId} ms=${Date.now() - started}`);
        else log(`[tts] provider=openai fallback=${fallbackReason}`);
      } catch (error) {
        if (timedOut) error.ttsReason = 'timeout';
        throw error;
      } finally {
        clearTimeout(timer);
        if (currentAbort === abort) currentAbort = undefined;
      }
    };
    let fallbackReason = 'missing_key';
    try {
      if (elevenLabsApiKey) {
        try { await attempt('elevenlabs'); return; }
        catch (error) {
          fallbackReason = error.ttsReason || (error.status ? `http_${error.status}` : error.message === 'empty_body' ? 'empty_body' : 'network_error');
          if (closed || res.headersSent || !apiKey) throw error;
        }
      }
      await attempt('openai', fallbackReason);
    } catch {
      if (!closed && !res.destroyed) {
        if (res.headersSent) res.destroy();
        else res.status(502).json({ error: 'Could not generate speech. The written reply is still available.' });
      }
      if (!logged) log(elevenLabsApiKey && !apiKey
        ? `[tts] provider=elevenlabs voice=${voiceId} model=${modelId} ms=${Date.now() - started}`
        : `[tts] provider=openai fallback=${fallbackReason}`);
    } finally { res.off('close', cancel); active--; }
  };
}
