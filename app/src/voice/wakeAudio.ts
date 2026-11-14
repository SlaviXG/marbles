import { hasWakePhrase, wakeStart } from './wakePhrase';
import { WAKE_GAIN_TARGET, WAKE_MAX_GAIN, WAKE_MIN_RMS } from './wakeConfig';

// Raise quiet speech for local recognition without amplifying it unboundedly.
// The original microphone audio is retained for command transcription.
export function normalizeWakeAudio(audio: Float32Array): Float32Array {
  let peak = 0;
  for (const sample of audio) peak = Math.max(peak, Math.abs(sample));
  const gain = peak ? Math.max(1, Math.min(WAKE_MAX_GAIN, WAKE_GAIN_TARGET / peak)) : 1;
  return audio.map(sample => Math.max(-1, Math.min(1, sample * gain)));
}

type WakeTranscript = {
  text: string;
  chunks?: { text: string; timestamp: [number | null, number | null] }[];
};

export function recognizedWakeStart(result: WakeTranscript, audio: Float32Array): number | undefined {
  if (!hasWakePhrase(result.text)) return;
  let onset: number | undefined;
  for (let start = 0; start < audio.length; start += 320) {
    const frame = audio.subarray(start, start + 320);
    const rms = Math.sqrt(frame.reduce((sum, sample) => sum + sample * sample, 0) / frame.length);
    if (rms >= WAKE_MIN_RMS) { onset = Math.max(0, start / 16_000 - 0.1); break; }
  }
  if (onset == null) return; // Never open the cloud gate for digital silence.
  const at = wakeStart(result.chunks ?? []);
  if (at != null && Number.isFinite(at) && at >= 0 && at < audio.length / 16_000) return at;
  // A recognized word must not be rejected because its timestamp is missing.
  // Retain the utterance from its audible onset; OpenAI strips the wake prefix.
  return onset;
}
