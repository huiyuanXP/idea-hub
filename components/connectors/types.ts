export interface WorkspaceConnection {
  id: string;
  name: string;
  projectId: string;
  project: string;
  version: string;
  status: string;
  lastSeen: number | null;
  agentReady: boolean;
  agentError: string | null;
  capabilities: string[];
  revokedAt: number | null;
  mcpLastSeen?: number | null;
  agentLastSeen?: number | null;
  workspace?: string;
  runtime?: { profile: string | null; model: string | null; provider: string | null; access?: "codex-config" | "codex-login" | "api" | "claude" | null } | null;
  events?: { id: string; mode: string; message: string | null; createdAt: number }[];
}

export interface ConnectionList {
  connections: WorkspaceConnection[];
  projects: { id: string; name: string }[];
}
