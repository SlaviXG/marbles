import { create } from 'zustand';

// Visual content the coordinator puts in front of the user: pictures from the
// web, a video, or an email / call waiting for a yes. One thing at a time.
export type WebImage = { url: string; full: string; title: string; credit: string; source?: string; width?: number; height?: number };
export type Display =
  | { kind: 'images'; query: string; images: WebImage[] }
  | { kind: 'video'; query: string; videoId: string; title: string; channel: string;
      /** Runners-up, tried in order if a video turns out not to allow embedding. */ alternates?: { videoId: string; title: string; channel: string }[] }
  | { kind: 'email'; to: string; name: string; subject: string; body: string }
  | { kind: 'call'; number: string; name: string };
export type Video = Extract<Display, { kind: 'video' }>;
export type DisplayStatus = 'idle' | 'working' | 'done' | 'failed';

interface DisplayState {
  display: Exclude<Display, Video> | null; // the one thing on the main stage
  video: Video | null; // plays in its own side window, alongside anything else
  videoLarge: boolean;
  videoIndex: number; // which candidate is playing: 0 is the first choice
  videoError: string;
  /** The player refused this video (not embeddable, removed, restricted): move to the next one. */
  skipVideo: () => void;
  /** The most recent thing that went wrong in the interface, for Marbles to explain. */
  issue: { text: string; at: number } | null;
  report: (text: string) => void;
  mailFallback: boolean; // the agent had no Gmail connector; offer Mail instead
  closeVideo: () => void;
  resizeVideo: (large: boolean) => void;
  index: number | null; // which picture is enlarged, if any
  status: DisplayStatus;
  note: string;
  show: (display: Display) => void;
  close: () => void;
  focus: (index: number | null) => void;
  step: (delta: number) => void;
  confirm: (via?: 'mail') => Promise<void>;
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That did not go through.');
  return data;
}

export const useDisplay = create<DisplayState>((set, get) => ({
  display: null, index: null, status: 'idle', note: '', video: null, videoLarge: false, videoIndex: 0, videoError: '', issue: null, mailFallback: false,
  show: display => set(display.kind === 'video' ? { video: display, videoIndex: 0, videoError: '' } : { display, index: null, status: 'idle', note: '', mailFallback: false }),
  closeVideo: () => set({ video: null, videoLarge: false, videoIndex: 0, videoError: '' }),
  report: text => set({ issue: { text, at: Date.now() } }),
  skipVideo: () => {
    const { video, videoIndex } = get();
    if (!video) return;
    const candidates = 1 + (video.alternates?.length ?? 0);
    if (videoIndex + 1 < candidates) { set({ videoIndex: videoIndex + 1 }); return; }
    const text = `None of the ${candidates} videos found for “${video.query}” allow playing inside another app.`;
    set({ videoError: text, issue: { text, at: Date.now() } });
  },
  resizeVideo: videoLarge => set({ videoLarge }),
  close: () => set({ display: null, index: null, status: 'idle', note: '' }),
  focus: index => set({ index }),
  step: delta => set(state => state.display?.kind !== 'images' ? state
    : { index: ((state.index ?? (delta > 0 ? -1 : 0)) + delta + state.display.images.length) % state.display.images.length }),
  // The only place an email is sent or a call is placed: an explicit yes.
  confirm: async via => {
    const { display, status } = get();
    if (!display || status === 'working' || status === 'done' || (display.kind !== 'email' && display.kind !== 'call')) return;
    const current = () => get().display === display;
    set({ status: 'working', note: '', mailFallback: false });
    try {
      if (display.kind === 'call') {
        const result = await post('/api/comms/call', { number: display.number });
        if (!result.started && result.link) window.location.href = result.link;
        if (current()) set({ status: 'done', note: 'Calling' });
        return;
      }
      const result = await post('/api/comms/email', { to: display.to, subject: display.subject, body: display.body, ...(via ? { via } : {}) });
      if (!result.taskId) {
        // Sent by the Mac's Mail app (or handed to the default mail handler).
        if (!result.sent && result.link) window.location.href = result.link;
        if (current()) set({ status: 'done', note: result.sent ? 'Sent with Mail' : 'Opened in your mail app' });
        return;
      }
      // An agent is sending it with its Gmail connector: wait for its verdict.
      if (current()) set({ note: 'An agent is sending it with Gmail' });
      for (let waited = 0; waited < 240_000 && current(); waited += 1500) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const outcome = await (await fetch(`/api/comms/email/${result.taskId}`, { signal: AbortSignal.timeout(8000) })).json();
        if (outcome.status === 'sending') continue;
        if (!current()) return;
        if (outcome.status === 'sent') { set({ status: 'done', note: `Sent by ${outcome.agentId || 'your agent'} with Gmail` }); return; }
        const text = outcome.status === 'unavailable' ? `${outcome.agentId || 'The agent'} has no Gmail connector signed in, so the email was not sent.` : `The email was not sent: ${outcome.reason}`;
        set({ status: 'failed', note: text, mailFallback: true, issue: { text, at: Date.now() } });
        return;
      }
      if (current()) set({ status: 'failed', note: 'Sending is taking too long. Check the agent’s task.', mailFallback: true });
    } catch (error) {
      const text = error instanceof Error ? error.message : 'That did not go through.';
      if (current()) set({ status: 'failed', note: text, issue: { text, at: Date.now() } });
    }
  },
}));
