import { localVoiceOrigin } from './voice.mjs';
import { DEFAULT_SPEECH_VOICE, isSpeechVoice } from '../../shared/speechVoices.mjs';

export function speechHandler({ apiKey = process.env.OPENAI_API_KEY, fetchApi = fetch } = {}) {
  let active = 0;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!localVoiceOrigin(req.headers.origin)) return res.status(403).json({ error: 'Speech playback requires a local app origin.' });
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2000) return res.status(400).json({ error: 'Supply reply text under 2,000 characters.' });
    const voice = req.body?.voice === undefined ? DEFAULT_SPEECH_VOICE : req.body.voice;
    if (!isSpeechVoice(voice)) return res.status(400).json({ error: 'Choose a supported speech voice.' });
    if (!apiKey) return res.status(503).json({ error: 'Set OPENAI_API_KEY and restart the server.' });
    if (active >= 2) return res.status(429).json({ error: 'Speech is busy. Please try again.' });
    active++;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25_000);
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancel);
    try {
      const response = await fetchApi('https://api.openai.com/v1/audio/speech', {
        method: 'POST', signal: abort.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text.trim(),
          instructions: 'Speak clearly, warmly, and concisely, like a helpful colleague. Read the supplied text exactly.',
          response_format: 'mp3' }),
      });
      if (!response.ok) throw new Error('Speech generation failed. Check OpenAI API access and billing.');
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('Speech response was too large.');
        chunks.push(Buffer.from(chunk));
      }
      if (!size) throw new Error('OpenAI returned empty speech.');
      if (!abort.signal.aborted) res.type('audio/mpeg').send(Buffer.concat(chunks));
    } catch (error) {
      if (!res.destroyed) res.status(502).json({ error: abort.signal.aborted ? 'Speech generation timed out or was cancelled.' : 'Could not generate speech. The written reply is still available.' });
    } finally { clearTimeout(timer); res.off('close', cancel); active--; }
  };
}
