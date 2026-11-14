import { create } from 'zustand';
import type { AgentInfo, AgentTask } from '../core/agentTypes';
interface AgentState {
  agents: AgentInfo[];
  tasks: AgentTask[];
  setAgents: (agents: AgentInfo[]) => void;
  setTasks: (tasks: AgentTask[]) => void;
  upsertAgent: (agent: AgentInfo) => void;
  removeAgent: (id: string) => void;
}
function retainTaskAgents(agents: AgentInfo[], previous: AgentInfo[], tasks: AgentTask[]) {
  const live = new Set(agents.map(a => a.id));
  const activeTasks = new Set(tasks.map(t => t.agentId));
  return [...agents, ...previous.filter(a => !live.has(a.id) && activeTasks.has(a.id)).map(a => ({ ...a, available: false }))];
}
export const useAgents = create<AgentState>((set) => ({
  agents: [], tasks: [],
  setAgents: (agents) => set(s => ({ agents: retainTaskAgents(agents, s.agents, s.tasks) })),
  setTasks: (tasks) => set(s => ({ tasks, agents: retainTaskAgents(s.agents.filter(a => a.available), s.agents, tasks) })),
  upsertAgent: (agent) => set(s => ({ agents: [...s.agents.filter(a => a.id !== agent.id), agent] })),
  removeAgent: (id) => set(s => ({ agents: retainTaskAgents(s.agents.filter(a => a.id !== id), s.agents, s.tasks) })),
}));
export async function refreshAgents() {
  const response = await fetch('/api/agents');
  if (response.ok) useAgents.getState().setAgents(await response.json());
}
export async function refreshTasks() {
  const response = await fetch('/api/tasks');
  if (response.ok) useAgents.getState().setTasks(await response.json());
}
