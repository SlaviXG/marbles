// While Marbles is listening to you or speaking to you, anything the app itself
// is playing steps back. That keeps your words clear of the soundtrack for the
// transcriber and lets you hear the reply. Players subscribe; the voice panel
// decides.
type Listener = (ducked: boolean) => void;
const listeners = new Set<Listener>();
let ducked = false;

export const DUCKED_VOLUME = 12; // percent of the player's own volume scale
export function setDucked(next: boolean) {
  if (next === ducked) return;
  ducked = next;
  for (const listener of [...listeners]) listener(ducked);
}
export const isDucked = () => ducked;
export function onDucking(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
