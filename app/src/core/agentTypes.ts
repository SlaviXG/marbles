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
