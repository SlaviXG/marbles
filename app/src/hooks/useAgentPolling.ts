import { useEffect } from 'react';
import { refreshAgents, refreshTasks, refreshSwarms, useAgents } from '../state/agents';
export function useAgentPolling() {
  useEffect(() => {
    let live = true;
    let stream: EventSource | null = null;
    const tasks = () => { void Promise.all([refreshTasks(), refreshAgents(), refreshSwarms()]).catch(() => {}); };
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
    // Poll faster while anything is running, so progress on the canvas feels live.
    let timer = 0;
    const busy = () => useAgents.getState().tasks.some(task => task.status === 'running') || useAgents.getState().swarms.some(swarm => ['running', 'evaluating'].includes(swarm.status));
    const loop = () => { tasks(); timer = window.setTimeout(loop, busy() ? 1500 : 5000); };
    loop();
    return () => { live = false; stream?.close(); window.clearTimeout(timer); };
  }, []);
}
