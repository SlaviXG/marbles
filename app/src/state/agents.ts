import { create } from 'zustand';
import type { AgentInfo, AgentTask } from '../core/agentTypes';
interface AgentState {
  agents: AgentInfo[];
  tasks: AgentTask[];
  setAgents: (agents: AgentInfo[]) => void;
  setTasks: (tasks: AgentTask[]) => void;
}
export const useAgents = create<AgentState>((set) => ({
  agents: [], tasks: [], setAgents: (agents) => set({ agents }), setTasks: (tasks) => set({ tasks }),
}));
export async function refreshAgents() {
  const response = await fetch('/api/agents');
  if (response.ok) useAgents.getState().setAgents(await response.json());
}
export async function refreshTasks() {
  const response = await fetch('/api/tasks');
  if (response.ok) useAgents.getState().setTasks(await response.json());
}
