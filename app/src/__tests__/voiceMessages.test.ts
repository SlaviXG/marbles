import { expect, it } from 'vitest';
import { upsertMessage, visibleMessages, MESSAGE_LIFETIME, type VoiceMessage } from '../voice/messages';

it('keeps only the three newest messages and updates live bubbles in place', () => {
  let messages: VoiceMessage[] = [];
  for (let i = 0; i < 4; i++) messages = upsertMessage(messages, { id: String(i), role: i % 2 ? 'assistant' : 'user', text: String(i) }, 0);
  expect(messages.map(m => m.id)).toEqual(['1', '2', '3']);
  messages = upsertMessage(messages, { id: '3', role: 'user', text: 'final text' }, 100);
  expect(messages).toHaveLength(3);
  expect(messages[2].text).toBe('final text');
});

it('expires old replies while keeping live transcription and pending handoffs', () => {
  let messages = upsertMessage([], { id: 'old', role: 'assistant', text: 'done' }, 0);
  messages = upsertMessage(messages, { id: 'live', role: 'user', text: 'speaking', pending: true }, 0);
  expect(visibleMessages(messages, MESSAGE_LIFETIME + 1).map(m => m.id)).toEqual(['live']);
});
