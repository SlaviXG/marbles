import type { Display } from '../state/display';

// Short spoken answers to whatever is on screen. Handled locally so "send it"
// or "next" is instant and can never be mistaken for a new task.
export type MediaAction = { action: 'confirm' | 'close' | 'closeVideo' | 'bigger' | 'smaller' | 'next' | 'previous' | 'grid'; reply: string };
const said = (text: string) => text.trim().toLowerCase().replace(/[.!?,]+$/g, '').replace(/^(?:ok(?:ay)?|yes|yeah|please)[, ]+/, '').replace(/\s+please$/, '');
type Stage = Exclude<Display, { kind: 'video' }>;

export function mediaCommand(text: string, display: Stage | null, video: boolean = false): MediaAction | null {
  const phrase = said(text);
  if (video) {
    if (/^(?:close|stop|hide|dismiss|turn off)(?: the)? video$/.test(phrase)) return { action: 'closeVideo', reply: 'Video closed.' };
    if (/^(?:make (?:it|the video) )?(?:bigger|larger)|(?:enlarge|expand|maximi[sz]e)(?: the)? video$/.test(phrase)) return { action: 'bigger', reply: '' };
    if (/^(?:make (?:it|the video) )?smaller|(?:shrink|minimi[sz]e)(?: the)? video$/.test(phrase)) return { action: 'smaller', reply: '' };
  }
  if (!display) {
    // With nothing else on stage, a bare "close" means the video.
    return video && /^(?:close|dismiss|hide|stop|exit)(?: (?:it|this|that))?$/.test(phrase) ? { action: 'closeVideo', reply: 'Video closed.' } : null;
  }
  if (/^(?:close|dismiss|hide|stop|exit)(?: (?:it|this|that|the (?:pictures?|images?|photos?|gallery|email|draft|call|screen)))?$/.test(phrase)) return { action: 'close', reply: 'Closed.' };
  if (display.kind === 'email') {
    if (/^(?:send|send it|send that|send the email|yes|yes send it|confirm|go ahead|do it)$/.test(phrase)) return { action: 'confirm', reply: 'Sending.' };
    if (/^(?:cancel|cancel it|discard|discard it|don'?t send(?: it)?|never ?mind|no)$/.test(phrase)) return { action: 'close', reply: 'Discarded.' };
  }
  if (display.kind === 'call') {
    if (/^(?:call|call now|call them|dial|yes|confirm|go ahead|do it)$/.test(phrase)) return { action: 'confirm', reply: 'Calling.' };
    if (/^(?:cancel|cancel it|don'?t call|never ?mind|no|hang up)$/.test(phrase)) return { action: 'close', reply: 'Cancelled.' };
  }
  if (display.kind === 'images') {
    if (/^(?:next|next one|next picture|next image|forward)$/.test(phrase)) return { action: 'next', reply: '' };
    if (/^(?:previous|previous one|back|go back|last one)$/.test(phrase)) return { action: 'previous', reply: '' };
    if (/^(?:show all|all of them|grid|show the grid|zoom out)$/.test(phrase)) return { action: 'grid', reply: '' };
  }
  return null;
}
