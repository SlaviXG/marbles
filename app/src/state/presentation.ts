import { create } from 'zustand';
import type { Presentation, PresentationPhase } from '../core/presentation';

interface PresentationState {
  active: Presentation | null;
  index: number;
  phase: PresentationPhase;
  phaseAt: number;
  queue: Presentation[];
  enqueue: (items: Presentation[]) => void;
  begin: (item: Presentation, index?: number) => void;
  show: () => void;
  choose: (index: number) => void;
  refresh: (item: Presentation) => void;
  dismiss: () => void;
  finishReturn: () => void;
}
export const usePresentation = create<PresentationState>((set) => ({
  active: null, index: 0, phase: 'idle', phaseAt: 0, queue: [],
  enqueue: items => set(state => {
    const known = new Set([state.active?.key, ...state.queue.map(item => item.key)]);
    const additions = items.filter(item => { if (known.has(item.key)) return false; known.add(item.key); return true; });
    return additions.length ? { queue: [...state.queue, ...additions] } : state;
  }),
  begin: (item, index = 0) => set(state => state.phase !== 'idle' ? state : ({ active: item,
    index: Math.max(0, Math.min(item.artifacts.length - 1, index)), phase: 'approaching', phaseAt: performance.now(), queue: state.queue.filter(queued => queued.key !== item.key) })),
  show: () => set(state => state.phase === 'approaching' ? { phase: 'presenting', phaseAt: performance.now() } : state),
  choose: index => set(state => state.active && state.phase !== 'returning' ? { index: Math.max(0, Math.min(state.active.artifacts.length - 1, index)) } : state),
  refresh: item => set(state => state.active?.key === item.key ? { active: item, index: Math.min(state.index, item.artifacts.length - 1) } : state),
  dismiss: () => set(state => state.active && state.phase !== 'returning' ? { phase: 'returning', phaseAt: performance.now() } : state),
  finishReturn: () => set(state => state.phase === 'returning' ? { active: null, phase: 'idle', phaseAt: performance.now(), index: 0 } : state),
}));

// The canvas publishes coordinates through a ref-like seam, not React updates
// on every animation frame. The floating screen uses the same live anchor.
type Point = { x: number; y: number };
let anchorProvider: ((id: string) => Point | null) | null = null;
export const presentationAnchor = { x: 0, y: 0 };
export function registerPresentationScene(provider: (id: string) => Point | null) {
  anchorProvider = provider;
  return () => { if (anchorProvider === provider) anchorProvider = null; };
}
export function agentScreenPoint(id: string): Point {
  return anchorProvider?.(id) ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}
