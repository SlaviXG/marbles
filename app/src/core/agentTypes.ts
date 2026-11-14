// Public discovery data returned by GET /api/agents.
export type AgentKind = "cli" | "desktop";

export interface DetectedAgent {
  id: string; // Catalog/provider ID, such as "codex".
  instanceName: string; // Stable local instance name, such as "pushkar-codex".
  name: string;
  kind: AgentKind;
  command: string | null; // CLI command name; null for desktop apps.
  path: string; // Executable or desktop bundle path.
  version: string | null;
  available: boolean;
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
}
export interface AgentLog {
  available: boolean;
  reason?: string;
  prompt?: { text: string; at: string | null } | null;
  messages?: { text: string; at: string | null }[];
  tools?: { name: string; args: string; at: string | null }[];
}
