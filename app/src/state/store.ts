import { create } from "zustand";
import type { Note } from "../core/types";

interface VaultState {
  notes: Record<string, Note>;
  connected: boolean;
  selectedId: string | null;
  setSnapshot: (notes: Note[]) => void;
  upsert: (note: Note) => void;
  remove: (id: string) => void;
  setConnected: (b: boolean) => void;
  select: (id: string) => void;
  clear: () => void;
}

export const useVault = create<VaultState>((set) => ({
  notes: {},
  connected: false,
  selectedId: null,
  setSnapshot: (arr) => set({ notes: Object.fromEntries(arr.map((n) => [n.id, n])) }),
  upsert: (note) => set((s) => ({ notes: { ...s.notes, [note.id]: note } })),
  remove: (id) =>
    set((s) => {
      const next = { ...s.notes };
      delete next[id];
      return { notes: next };
    }),
  setConnected: (connected) => set({ connected }),
  select: (selectedId) => set({ selectedId }),
  clear: () => set({ selectedId: null }),
}));

// Granular selector hooks: a component using useNote(id) only re-renders when
// THAT note changes, which is the "hook per UI element" reactivity we want.
export const useNoteIds = () => useVault((s) => Object.keys(s.notes));
export const useNote = (id: string) => useVault((s) => s.notes[id]);
