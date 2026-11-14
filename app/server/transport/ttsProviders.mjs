export const DEFAULT_ELEVENLABS_VOICE_ID = 'DODLEQrClDo8wCz460ld';
export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_flash_v2_5';

export async function elevenLabsTts({
  text, apiKey = process.env.ELEVENLABS_API_KEY,
  voiceId = process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_VOICE_ID,
  modelId = process.env.ELEVENLABS_MODEL_ID || DEFAULT_ELEVENLABS_MODEL_ID,
  fetchApi = fetch, signal,
}) {
  if (!/^[A-Za-z0-9]{10,40}$/.test(voiceId)) throw new Error('Invalid ElevenLabs voice ID.');
  const response = await fetchApi(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
    method: 'POST', signal,
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: modelId }),
  });
  if (!response.ok) {
    const error = new Error('ElevenLabs speech generation failed.');
    error.status = response.status;
    throw error;
  }
  return response.body;
}

export async function openAiTts({ text, voice, apiKey = process.env.OPENAI_API_KEY, fetchApi = fetch, signal }) {
  const response = await fetchApi('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text,
      instructions: 'Speak clearly, warmly, and concisely, like a helpful colleague. Read the supplied text exactly.',
      response_format: 'mp3' }),
  });
  if (!response.ok) throw new Error('OpenAI speech generation failed.');
  return response.body;
}
