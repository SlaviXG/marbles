import { create } from 'zustand';
import type { VoiceStatus } from '../voice/VoiceSession';

// Voice state shared with the rest of the projection, so the whole scene can
// answer the user's voice (the core, the canvas rings, the HUD frame).
// `voiceSignal` is a plain mutable object read inside animation frames: mic
// energy changes far too often to route through React.
export const voiceSignal = {
  level: 0, // raw mic energy, 0..1
  status: 'idle' as VoiceStatus,
  speaking: false, // the assistant's spoken reply is playing
  awakeAt: -1e9, // performance.now() of the last wake / arm, for the shockwave
};

interface HudState {
  voice: VoiceStatus;
  speaking: boolean;
  setVoice: (voice: VoiceStatus) => void;
  setSpeaking: (speaking: boolean) => void;
}

export const useHud = create<HudState>((set) => ({
  voice: 'idle',
  speaking: false,
  setVoice: (voice) => {
    if (voice === 'armed' && voiceSignal.status !== 'armed') voiceSignal.awakeAt = performance.now();
    voiceSignal.status = voice;
    set({ voice });
  },
  setSpeaking: (speaking) => {
    voiceSignal.speaking = speaking;
    set({ speaking });
  },
}));

export const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const HUD_FONT = '"DIN Alternate", "Bahnschrift", "Avenir Next", ui-sans-serif, system-ui, sans-serif';
