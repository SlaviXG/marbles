// Semantic actions: the layer between "what the user did" and "what happens".
//
// Without it, every input path hard-codes its own outcome. The two-handed pinch
// knew it meant "send a ctrl+wheel to the graph", so a second gesture for the
// same intent would duplicate that, and a second surface wanting to be zoomed
// (an open note) had no way to claim it. Splitting the two lets many gestures
// produce one action, and lets the action land wherever is currently in front.
//
// Producers (gesture recognisers, the wheel listener) call dispatchAction.
// Consumers (views) register a handler and return true if they took it.
// Handlers run highest priority first and the first claim wins: a Chain of
// Responsibility, the same shape detail.ts already uses to resolve a node id.
// Priority encodes what is in front of what, so an open note outranks the graph
// behind it without either knowing the other exists.

export interface ZoomAction {
  type: "zoom";
  // Wheel-style delta: negative zooms in, matching deltaY so the mouse path and
  // the gesture path carry the same units.
  delta: number;
  // Viewport px the zoom is anchored on (gesture midpoint, or the cursor).
  x: number;
  y: number;
  // True when it came from a pinch rather than a wheel notch. Pinch deltas are
  // small and continuous, so consumers give them more gain, exactly as the
  // browser's own ctrl+wheel convention implies.
  pinch: boolean;
}

// Move the content under the pointer, in viewport px. Emitted alongside zoom by
// the two-handed gesture: the hands' midpoint moving is a pan, their separation
// changing is a zoom, and doing both at once is how a person actually navigates.
export interface PanAction {
  type: "pan";
  dx: number;
  dy: number;
}

export type Action = ZoomAction | PanAction;

// Bigger wins. Named so registration sites read as intent, not as magic numbers.
export const PRIORITY = {
  overlay: 100, // an open note, in front of everything
  world: 0, // the graph canvas, the default surface
} as const;

type Entry = { fn: (a: Action) => boolean; priority: number };

const handlers: Entry[] = [];

// HMR would hot-swap this module and strip registrations while the views that
// made them live on in the old instance, leaving actions silently unhandled.
// Same reasoning as the pointerTarget and magnet-provider singletons.
if ((import.meta as { hot?: { decline(): void } }).hot) {
  (import.meta as { hot?: { decline(): void } }).hot!.decline();
}

export function registerActionHandler(
  fn: (a: Action) => boolean,
  priority: number = PRIORITY.world,
): () => void {
  const entry: Entry = { fn, priority };
  handlers.push(entry);
  handlers.sort((a, b) => b.priority - a.priority);
  return () => {
    const i = handlers.indexOf(entry);
    if (i >= 0) handlers.splice(i, 1);
  };
}

// Returns true if some handler claimed it. Iterates a copy: a handler is allowed
// to register or unregister during dispatch (an overlay closing on a gesture).
export function dispatchAction(action: Action): boolean {
  for (const h of handlers.slice()) {
    if (h.fn(action)) return true;
  }
  return false;
}
