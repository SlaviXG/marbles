import { DEFAULT_SPEECH_VOICE, isSpeechVoice, type SpeechVoice } from '../../shared/speechVoices.mjs';

export function spokenText(text: string): string {
  let plain = text.replace(/```[\s\S]*?```/g, ' Code is in the message. ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link in the message')
    .replace(/[*_`#]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (plain.length <= 700) return plain;
  const end = plain.slice(0, 620).lastIndexOf('. ');
  return `${plain.slice(0, end > 250 ? end + 1 : 620)} Details are in the message.`;
}

type SpeakerEvents = { active: (value: boolean) => void; error: (message: string) => void };

// A bounded queue reads final replies once. Text remains independent of audio
// failures; interruption/muting cancels synthesis and releases audio resources.
export class ReplySpeaker {
  private enabled = true;
  private speaking = false;
  private disposed = false;
  private busy = false;
  private queue: string[] = [];
  private seen = new Set<string>();
  private cache = new Map<string, Blob>();
  private abort?: AbortController;
  private audio?: HTMLAudioElement;
  private url?: string;
  private generation = 0;
  private voice: SpeechVoice = DEFAULT_SPEECH_VOICE;

  constructor(private events: SpeakerEvents) {}

  enqueue(id: string, text: string) {
    const plain = spokenText(text);
    const key = `${this.voice}:${id}:${plain}`;
    if (!plain || !this.enabled || this.disposed || this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 200) this.seen.delete(this.seen.values().next().value!);
    this.queue = [...this.queue, plain].slice(-3);
    void this.pump();
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.interrupt();
  }

  setVoice(voice: SpeechVoice) {
    if (!isSpeechVoice(voice) || voice === this.voice) return;
    this.interrupt();
    this.voice = voice;
  }

  setUserSpeaking(speaking: boolean) {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    if (speaking) this.interrupt();
    else void this.pump();
  }

  private async pump() {
    if (this.busy || !this.enabled || this.speaking || this.disposed || !this.queue.length) return;
    this.busy = true;
    const text = this.queue.shift()!;
    const voice = this.voice;
    const cacheKey = `${voice}:${text}`;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const timer = setTimeout(() => abort.abort(), 30_000);
    try {
      let blob = this.cache.get(cacheKey);
      if (!blob) {
        const response = await fetch('/api/voice/speech', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }), signal: abort.signal });
        if (!response.ok) throw new Error('Could not generate speech. Read the message or retry audio.');
        blob = await response.blob();
      }
      if (generation !== this.generation || abort.signal.aborted || this.disposed) return;
      clearTimeout(timer);
      if (!blob.size || !blob.type.startsWith('audio/')) throw new Error('The speech response was not audio.');
      this.cache.set(cacheKey, blob);
      if (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value!);
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      this.audio = audio;
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('Audio playback failed. The written reply is still available.'));
        abort.signal.addEventListener('abort', () => resolve(), { once: true });
        this.events.active(true);
        void audio.play().catch(() => reject(new Error('Your browser blocked audio. Use the Read aloud button on a reply.')));
      });
    } catch (error) {
      if (!abort.signal.aborted && generation === this.generation && !this.disposed) {
        this.queue = [];
        this.events.error(error instanceof Error ? error.message : 'Speech playback failed.');
      }
    } finally {
      clearTimeout(timer);
      if (generation === this.generation) {
        this.release(); this.busy = false;
        void this.pump();
      }
    }
  }

  private release() {
    if (this.audio) {
      this.audio.onended = this.audio.onerror = null;
      this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); this.audio = undefined;
    }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = undefined; }
    this.events.active(false);
  }

  interrupt() {
    this.generation++;
    this.queue = [];
    this.abort?.abort(); this.abort = undefined;
    this.release(); this.busy = false;
  }

  dispose() { this.disposed = true; this.interrupt(); }
}
