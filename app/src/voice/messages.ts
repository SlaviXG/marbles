export type VoiceRequest = { transcript: string; requestId: string; conversationId?: string; selectedId?: string | null;
  /** Said while the previous request was still being handled, oldest first. */ earlier?: string[] };
export type VoicePlan = { plan: string[]; assumptions: string[] };
export type VoiceMessage = {
  id: string; role: 'user' | 'assistant'; text: string; label?: string;
  pending?: boolean; taskId?: string; plan?: VoicePlan;
  swarmId?: string; retry?: VoiceRequest; expiresAt: number;
};
export const MESSAGE_LIFETIME = 20_000;

export function statusMessage(id: string, response: { state: string; reply?: string }): Omit<VoiceMessage, 'expiresAt'> | null {
  return (response.state === 'status' || response.state === 'log') && typeof response.reply === 'string'
    ? { id, role: 'assistant', text: response.reply } : null;
}

export function upsertMessage(messages: VoiceMessage[], message: Omit<VoiceMessage, 'expiresAt'>, now: number): VoiceMessage[] {
  const next = { ...message, expiresAt: now + MESSAGE_LIFETIME };
  return messages.some(item => item.id === message.id)
    ? messages.map(item => item.id === message.id ? next : item)
    : [...messages, next].slice(-3);
}

export function visibleMessages(messages: VoiceMessage[], now: number): VoiceMessage[] {
  return messages.filter(message => message.pending || message.expiresAt > now).slice(-3);
}
