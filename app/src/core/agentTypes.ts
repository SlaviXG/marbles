// Public discovery data returned by GET /api/agents.
export type AgentKind = "cli" | "desktop";

export interface DetectedAgent {
  id: string; // Catalog/provider ID, such as "codex".
  name: string;
  kind: AgentKind;
  command: string | null; // CLI command name; null for desktop apps.
  path: string; // Executable or desktop bundle path.
  version: string | null;
  available: boolean;
  reason?: string;
  codingAgent: boolean; // Catalog eligibility for the agent canvas.
  status?: 'idle' | 'running' | 'unavailable';
}
export type AgentInfo = DetectedAgent;
export interface ArtifactInfo { path: string; name: string; type: 'pdf' | 'spreadsheet' | 'docx' | 'image' | 'code' | 'other' }
export interface AgentTask {
  id: string;
  agentId: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  stdout: string;
  stderr: string;
  artifacts: ArtifactInfo[];
  source?: 'text' | 'voice';
  transcript?: string;
  title?: string;
  intent?: { problem: string; objective: string; constraints: string[]; successCriteria: string[] };
  routing?: RoutingDecision;
}
export interface RoutingDecision { mode: 'solo' | 'swarm'; reason: string; signals: { privateInputs: boolean; files: number; searchBreadth: boolean; sections: number; subparts: number; estimatedSize: number } }
export interface AgentLog {
  available: boolean;
  reason?: string;
  prompt?: { text: string; at: string | null } | null;
  messages?: { text: string; at: string | null }[];
  tools?: { name: string; args: string; at: string | null }[];
}

export interface SwarmPost { ts: string; seq: number; agentId: string; turn: number; kind: 'claim' | 'note' | 'contribution' | 'question' | 'done'; text: string }
export interface SwarmRun { agentId: string; turn: number; status: string; startedAt: string; endedAt: string | null; outputChars: number; stdout: string }
export interface SwarmTask { id: string; goal: string; mode: 'swarm' | 'best-of-n'; agents: string[]; status: 'running' | 'evaluating' | 'completed' | 'failed' | 'cancelled'; createdAt: string; endedAt: string | null; runs: SwarmRun[]; blackboard: SwarmPost[]; artifacts: ArtifactInfo[]; reward: number | null; success: number | null; tokenProxy: number; contributions: Record<string, number>; rationale: string; lesson: string; winnerId?: string; routing?: RoutingDecision }
