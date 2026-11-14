// Built-in voices supported by gpt-4o-mini-tts.
export const SPEECH_VOICES = Object.freeze([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova',
  'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
]);
export const DEFAULT_SPEECH_VOICE = 'coral';
export const isSpeechVoice = value => typeof value === 'string' && SPEECH_VOICES.includes(value);
