import { create } from 'zustand';
import type { AgentInfo, AgentTask, SwarmTask } from '../core/agentTypes';
interface AgentState {
  agents: AgentInfo[];
  tasks: AgentTask[];
  swarms: SwarmTask[];
  setSwarms: (swarms: SwarmTask[]) => void;
  upsertSwarm: (swarm: SwarmTask) => void;
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
  agents: [], tasks: [], swarms: [],
  setSwarms: (swarms) => set({ swarms }),
  upsertSwarm: (swarm) => set(s => ({ swarms: [swarm, ...s.swarms.filter(item => item.id !== swarm.id)] })),
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

export async function refreshSwarms() {
  const response = await fetch('/api/swarm/tasks');
  if (response.ok) useAgents.getState().setSwarms(await response.json());
}

export async function refreshSwarm(id: string) {
  const response = await fetch(`/api/swarm/tasks/${encodeURIComponent(id)}`);
  if (response.ok) useAgents.getState().upsertSwarm(await response.json());
}
