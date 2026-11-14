// A minimal observable store: getState / setState / subscribe. The same shape
// React's useSyncExternalStore (and zustand's useStore) expect, so any UI layer
// can bind to it, while the library itself stays free of dependencies.

export interface Store<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
  // Called after every change. Returns an unsubscribe.
  subscribe(listener: () => void): () => void;
}

export function createStore<T extends object>(
  init: (set: (partial: Partial<T>) => void, get: () => T) => T,
): Store<T> {
  let state: T;
  const listeners = new Set<() => void>();
  const getState = () => state;
  const setState = (partial: Partial<T>) => {
    // A fresh object per change, so identity comparison detects it.
    state = { ...state, ...partial };
    for (const l of [...listeners]) l();
  };
  state = init(setState, getState);
  return {
    getState,
    setState,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
