import { create } from 'zustand';

// Visual content the coordinator puts in front of the user: pictures from the
// web, a video, or an email / call waiting for a yes. One thing at a time.
export type WebImage = { url: string; full: string; title: string; credit: string; source?: string; width?: number; height?: number };
export type Display =
  | { kind: 'images'; query: string; images: WebImage[] }
  | { kind: 'video'; query: string; videoId: string; title: string; channel: string }
  | { kind: 'email'; to: string; name: string; subject: string; body: string }
  | { kind: 'call'; number: string; name: string };
export type Video = Extract<Display, { kind: 'video' }>;
export type DisplayStatus = 'idle' | 'working' | 'done' | 'failed';

interface DisplayState {
  display: Exclude<Display, Video> | null; // the one thing on the main stage
  video: Video | null; // plays in its own side window, alongside anything else
  videoLarge: boolean;
  closeVideo: () => void;
  resizeVideo: (large: boolean) => void;
  index: number | null; // which picture is enlarged, if any
  status: DisplayStatus;
  note: string;
  show: (display: Display) => void;
  close: () => void;
  focus: (index: number | null) => void;
  step: (delta: number) => void;
  confirm: () => Promise<void>;
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'That did not go through.');
  return data;
}

export const useDisplay = create<DisplayState>((set, get) => ({
  display: null, index: null, status: 'idle', note: '', video: null, videoLarge: false,
  show: display => set(display.kind === 'video' ? { video: display } : { display, index: null, status: 'idle', note: '' }),
  closeVideo: () => set({ video: null, videoLarge: false }),
  resizeVideo: videoLarge => set({ videoLarge }),
  close: () => set({ display: null, index: null, status: 'idle', note: '' }),
  focus: index => set({ index }),
  step: delta => set(state => state.display?.kind !== 'images' ? state
    : { index: ((state.index ?? (delta > 0 ? -1 : 0)) + delta + state.display.images.length) % state.display.images.length }),
  // The only place an email is sent or a call is placed: an explicit yes.
  confirm: async () => {
    const { display, status } = get();
    if (!display || status === 'working' || status === 'done' || (display.kind !== 'email' && display.kind !== 'call')) return;
    set({ status: 'working', note: '' });
    try {
      if (display.kind === 'email') {
        const result = await post('/api/comms/email', { to: display.to, subject: display.subject, body: display.body });
        if (!result.sent && result.link) window.location.href = result.link;
        if (get().display === display) set({ status: 'done', note: result.sent ? 'Sent' : 'Opened in your mail app' });
      } else {
        const result = await post('/api/comms/call', { number: display.number });
        if (!result.started && result.link) window.location.href = result.link;
        if (get().display === display) set({ status: 'done', note: 'Calling' });
      }
    } catch (error) {
      if (get().display === display) set({ status: 'failed', note: error instanceof Error ? error.message : 'That did not go through.' });
    }
  },
}));
