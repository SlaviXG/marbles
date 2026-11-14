import { useEffect, useState } from 'react';
import type { VoiceMessage, VoiceRequest } from '../voice/messages';
import { useVault } from '../state/store';

// Spoken exchanges appear as film subtitles above the voice core: the latest
// thing you said, and the latest answer. Nothing accumulates; lines dissolve
// once they have been heard. Plans and logs live in the task detail instead.
const FADE_MS = 900;

export default function VoiceConversation({ messages, retry }: {
  messages: VoiceMessage[];
  retry: (request: VoiceRequest) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!messages.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, [messages]);

  const alive = messages.filter(message => message.pending || message.expiresAt > now);
  const user = [...alive].reverse().find(message => message.role === 'user');
  const reply = [...alive].reverse().find(message => message.role === 'assistant');
  // Once an answer exists, the question it answers steps back.
  const lines = [user, reply].filter((message): message is VoiceMessage => !!message)
    .sort((a, b) => messages.indexOf(a) - messages.indexOf(b));

  return <aside className="voice-subtitles" aria-label="Recent voice messages">
    <div role="log" aria-live="polite" aria-relevant="additions text">
      {lines.map(message => {
        const fading = !message.pending && message.expiresAt - now < FADE_MS;
        const thinking = message.role === 'assistant' && message.pending;
        return <div key={message.id} className={`subtitle ${message.role}${message.pending ? ' pending' : ''}${fading ? ' fading' : ''}`}>
          {thinking
            ? <p className="subtitle-thinking"><span className="voice-sr-only">{message.text}</span><i /><i /><i /></p>
            : <p aria-live={message.role === 'user' ? 'off' : undefined}>
              {message.text.split(/(\s+)/).map((word, index) => /^\s+$/.test(word) ? word
                : <span key={index} style={{ animationDelay: `${message.role === 'assistant' ? Math.min(index * 14, 900) : 0}ms` }}>{word}</span>)}
            </p>}
          {(message.taskId || message.swarmId || message.retry) && <div className="subtitle-actions">
            {message.taskId && <button type="button" onClick={() => useVault.getState().select(`task:${message.taskId}`)}>Open task</button>}
            {message.swarmId && <button type="button" onClick={() => useVault.getState().select(`swarm:${message.swarmId}`)}>Open team</button>}
            {message.retry && <button type="button" onClick={() => retry(message.retry!)}>Retry</button>}
          </div>}
        </div>;
      })}
    </div>
  </aside>;
}
