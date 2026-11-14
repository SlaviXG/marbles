import { emptyTranscript, transcriptText, updateTranscript } from './transcript';
import type { TranscriptEvent } from './VoiceSession';

// Submit as soon as all finals have arrived and the user has paused. Never
// dispatch interim text or the same item twice, even with duplicate events.
export class CommandBuffer {
  private state = emptyTranscript();
  private consumed = new Set<string>();
  private speaking = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private submit: (text: string) => void) {}
  event(event: TranscriptEvent) {
    this.state = updateTranscript(this.state, event);
    this.schedule();
  }
  activity(speaking: boolean) {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.disposed || this.speaking) return;
    const ids = this.state.order.filter(id => !this.consumed.has(id));
    if (!ids.length || ids.some(id => !this.state.items[id]?.final)) return;
    if (Object.keys(this.state.items).some(id => !this.consumed.has(id) && !this.state.items[id].final)) return;
    this.timer = setTimeout(() => {
      ids.forEach(id => this.consumed.add(id));
      const text = transcriptText({ order: ids, items: Object.fromEntries(ids.map(id => [id, this.state.items[id]])) });
      if (text) this.submit(text);
    }, 0);
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
