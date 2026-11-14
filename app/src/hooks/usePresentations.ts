import { useEffect, useLayoutEffect, useRef } from 'react';
import { CompletionTracker, resolvePresentation, artifactSelection, PRESENTATION_ENTER_MS, PRESENTATION_RETURN_MS } from '../core/presentation';
import { useAgents } from '../state/agents';
import { usePresentation } from '../state/presentation';
import { useVault } from '../state/store';
import { useDisplay } from '../state/display';

export function usePresentations() {
  const tracker = useRef(new CompletionTracker());
  const tasks = useAgents(s => s.tasks);
  const swarms = useAgents(s => s.swarms);
  const tasksLoaded = useAgents(s => s.tasksLoaded);
  const swarmsLoaded = useAgents(s => s.swarmsLoaded);
  const selectedId = useVault(s => s.selectedId);
  const active = usePresentation(s => s.active);
  const phase = usePresentation(s => s.phase);
  const queue = usePresentation(s => s.queue);
  const showing = useDisplay(s => !!s.display);
  useEffect(() => {
    const ready = [ ...(tasksLoaded ? tracker.current.observe('task', tasks) : []), ...(swarmsLoaded ? tracker.current.observe('swarm', swarms) : []) ];
    if (ready.length) usePresentation.getState().enqueue(ready);
  }, [tasks, swarms, tasksLoaded, swarmsLoaded]);

  useLayoutEffect(() => {
    const state = usePresentation.getState();
    const selection = resolvePresentation(selectedId, tasks, swarms);
    if (state.phase === 'idle') {
      if (selection) state.begin(selection.item, selection.index);
      // A waiting result never takes the stage from something being looked at.
      else if (!selectedId && !showing && state.queue.length) {
        const next = state.queue[0];
        const fresh = resolvePresentation(artifactSelection(next), tasks, swarms)?.item ?? next;
        useVault.getState().select(artifactSelection(next));
        state.begin(fresh);
      }
    } else if (state.phase !== 'returning' && state.active) {
      if (selection?.item.key === state.active.key) {
        if (selection.item.artifacts.map(file => file.path).join('\n') !== state.active.artifacts.map(file => file.path).join('\n')) state.refresh(selection.item);
        if (selection.index !== state.index) state.choose(selection.index);
      } else if (selectedId !== artifactSelection(state.active, state.index)) state.dismiss();
    }
  }, [selectedId, active, phase, queue, tasks, swarms, showing]);

  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (phase === 'approaching') {
      const timer = window.setTimeout(() => usePresentation.getState().show(), reduced ? 0 : PRESENTATION_ENTER_MS);
      return () => clearTimeout(timer);
    }
    if (phase === 'returning') {
      const timer = window.setTimeout(() => usePresentation.getState().finishReturn(), reduced ? 0 : PRESENTATION_RETURN_MS);
      return () => clearTimeout(timer);
    }
  }, [phase]);
}
