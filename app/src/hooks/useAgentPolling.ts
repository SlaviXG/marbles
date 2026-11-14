import { useEffect } from 'react';
import { refreshAgents, refreshTasks, useAgents } from '../state/agents';
export function useAgentPolling() {
  useEffect(() => {
    let live = true;
    let stream: EventSource | null = null;
    const tasks = () => { void Promise.all([refreshTasks(), refreshAgents()]).catch(() => {}); };
    void refreshAgents().catch(() => {}).then(() => {
      if (!live) return;
      stream = new EventSource('/api/agents/stream');
      stream.addEventListener('snapshot', e => useAgents.getState().setAgents(JSON.parse((e as MessageEvent).data)));
      stream.addEventListener('added', e => useAgents.getState().upsertAgent(JSON.parse((e as MessageEvent).data)));
      stream.addEventListener('changed', e => useAgents.getState().upsertAgent(JSON.parse((e as MessageEvent).data)));
      stream.addEventListener('removed', e => {
        const { id } = JSON.parse((e as MessageEvent).data);
        // Fetch tasks first so a just-started task keeps its agent bubble visible.
        void refreshTasks().catch(() => {}).then(() => useAgents.getState().removeAgent(id));
      });
    });
    tasks();
    const timer = window.setInterval(tasks, 5000);
    return () => { live = false; stream?.close(); window.clearInterval(timer); };
  }, []);
}
