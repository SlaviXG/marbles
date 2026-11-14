import type { VoiceMessage, VoiceRequest } from '../voice/messages';
import { useVault } from '../state/store';

export default function VoiceConversation({ messages, now, pause, resume, retry, read }: {
  messages: VoiceMessage[]; now: number; pause: () => void; resume: () => void;
  retry: (request: VoiceRequest) => void;
  read?: (text: string) => void;
}) {
  return <aside className="voice-conversation" aria-label="Recent voice messages"
    onMouseEnter={pause} onMouseLeave={resume} onFocusCapture={pause}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) resume(); }}>
    <div className="voice-messages" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map(message => <div key={message.id}
        className={`voice-message ${message.role}${message.pending ? ' pending' : ''}${!message.pending && message.expiresAt - now < 1500 ? ' fading' : ''}`}>
        <span className="voice-message-label">{message.label ?? (message.role === 'user' ? 'You' : 'Marbles')}</span>
        <p aria-live={message.role === 'user' ? 'off' : undefined}>{message.text}</p>
        {(message.taskId || message.retry || (read && message.role === 'assistant' && !message.pending)) && <div className="voice-message-actions">
          {read && message.role === 'assistant' && !message.pending && <button type="button" onClick={() => read(message.text)}>Read aloud</button>}
          {message.taskId && <button type="button" onClick={() => useVault.getState().select(`task:${message.taskId}`)}>View task ↗</button>}
          {message.retry && <button type="button" onClick={() => retry(message.retry!)}>Retry task</button>}
        </div>}
      </div>)}
    </div>
  </aside>;
}
