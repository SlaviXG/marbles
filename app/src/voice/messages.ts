export type VoiceRequest = { transcript: string; requestId: string };
export type VoiceMessage = {
  id: string; role: 'user' | 'assistant'; text: string; label?: string;
  pending?: boolean; taskId?: string;
  swarmId?: string; retry?: VoiceRequest; expiresAt: number;
};
export const MESSAGE_LIFETIME = 20_000;

export function upsertMessage(messages: VoiceMessage[], message: Omit<VoiceMessage, 'expiresAt'>, now: number): VoiceMessage[] {
  const next = { ...message, expiresAt: now + MESSAGE_LIFETIME };
  return messages.some(item => item.id === message.id)
    ? messages.map(item => item.id === message.id ? next : item)
    : [...messages, next].slice(-3);
}

export function visibleMessages(messages: VoiceMessage[], now: number): VoiceMessage[] {
  return messages.filter(message => message.pending || message.expiresAt > now).slice(-3);
}
