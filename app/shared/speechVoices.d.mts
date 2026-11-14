export type SpeechVoice = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
export const SPEECH_VOICES: readonly SpeechVoice[];
export const DEFAULT_SPEECH_VOICE: SpeechVoice;
export function isSpeechVoice(value: unknown): value is SpeechVoice;
