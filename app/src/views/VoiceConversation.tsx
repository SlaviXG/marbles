import type { VoiceMessage, VoiceRequest } from '../voice/messages';
import { useVault } from '../state/store';

export default function VoiceConversation({ messages, retry, read }: {
  messages: VoiceMessage[];
  retry: (request: VoiceRequest) => void;
  read?: (text: string) => void;
}) {
  return <aside className="voice-conversation" aria-label="Recent voice messages">
    <div className="voice-messages" role="log" aria-live="polite" aria-relevant="additions text">
      {messages.map(message => <div key={message.id}
        className={`voice-message ${message.role}${message.pending ? ' pending' : ''}`}>
        <span className="voice-message-label">{message.label ?? (message.role === 'user' ? 'You' : 'Marbles')}</span>
        <p aria-live={message.role === 'user' ? 'off' : undefined}>{message.text}</p>
        {message.plan && <details className="voice-plan">
          <summary>Plan & assumptions</summary>
          <ol>{message.plan.plan.map((step, i) => <li key={i}>{step}</li>)}</ol>
          {message.plan.assumptions.length > 0 && <><span>Assuming</span><ul>{message.plan.assumptions.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
        </details>}
        {(message.taskId || message.swarmId || message.retry || (read && message.role === 'assistant' && !message.pending)) && <div className="voice-message-actions">
          {read && message.role === 'assistant' && !message.pending && <button type="button" onClick={() => read(message.text)}>Read aloud</button>}
          {message.taskId && <button type="button" onClick={() => useVault.getState().select(`task:${message.taskId}`)}>View task ↗</button>}
          {message.swarmId && <button type="button" onClick={() => useVault.getState().select(`swarm:${message.swarmId}`)}>View swarm ↗</button>}
          {message.retry && <button type="button" onClick={() => retry(message.retry!)}>Retry task</button>}
        </div>}
      </div>)}
    </div>
  </aside>;
}
