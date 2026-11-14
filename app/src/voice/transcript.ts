import type { TranscriptEvent } from "./VoiceSession";

export type Transcript = { order: string[]; items: Record<string, { text: string; final: boolean }> };
export const emptyTranscript = (): Transcript => ({ order: [], items: {} });

// Commit acknowledgements establish speech order, not completion arrival order.
export function updateTranscript(state: Transcript, event: TranscriptEvent): Transcript {
  const id = event.item_id;
  if (!id) return state;
  const current = state.items[id] ?? { text: "", final: false };
  if (event.type === "committed") {
    return { ...state, order: state.order.includes(id) ? state.order : [...state.order, id] };
  }
  if (event.type !== "delta" && event.type !== "completed") return state;
  if (current.final) return state;
  const item = event.type === "completed"
    ? { text: event.transcript ?? "", final: true }
    : { text: current.text + (event.delta ?? ""), final: false };
  return { ...state, items: { ...state.items, [id]: item } };
}

export function transcriptText(state: Transcript): string {
  // A live delta may precede the commit that gives its item an ordered slot.
  const ids = [...state.order, ...Object.keys(state.items).filter((id) => !state.order.includes(id))];
  return ids.map((id) => state.items[id]?.text.trim()).filter(Boolean).join(" ");
}
