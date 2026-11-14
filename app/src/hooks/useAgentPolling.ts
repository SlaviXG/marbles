import { useEffect } from 'react';
import { refreshAgents, refreshTasks } from '../state/agents';
export function useAgentPolling() {
  useEffect(() => {
    const refresh = () => { void refreshAgents().catch(() => {}); void refreshTasks().catch(() => {}); };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, []);
}
