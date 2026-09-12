export type AgentCapability =
  | "durable_session" | "streaming" | "sandbox" | "mcp" | "tools"
  | "artifacts" | "subagents" | "approvals" | "secrets" | "files";

export interface ProviderCapabilities {
  supported: AgentCapability[];
  native: AgentCapability[];
  emulated?: AgentCapability[];
  limits?: Record<string, number | string | boolean>;
}

export type SessionStatus = "idle" | "in_progress" | "requires_action" | "failed" | "cancelled";
export interface AgentMessage { role: "user" | "assistant" | "system"; content: string; }
export interface AgentEnvironment { type: "none" | "hosted" | "external"; ref?: string; config?: Record<string, unknown>; }
export interface AgentDefinition {
  model?: string;
  instructions?: string;
  name?: string;
  tools?: unknown[];
  mcpServers?: unknown[];
  multiAgent?: { enabled: boolean; maxConcurrentSubagents?: number };
  vendor?: Record<string, unknown>;
}
export interface CreateSessionRequest {
  provider?: string;
  requiredCapabilities?: AgentCapability[];
  agent: AgentDefinition;
  environment?: AgentEnvironment;
  input?: string | AgentMessage[];
  metadata?: Record<string,string>;
}
export interface AgentSession {
  id: string;
  provider: string;
  providerSessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt?: string;
  metadata?: Record<string,string>;
  requiredActions?: unknown[];
  usage?: Record<string,unknown>;
  raw?: unknown;
}
export type AgentEvent =
  | { type: "session.created" | "session.updated"; session: AgentSession }
  | { type: "output.delta"; delta: string; raw?: unknown }
  | { type: "tool.call" | "tool.result" | "artifact" | "approval.required" | "provider.event"; data: unknown }
  | { type: "error"; error: { message: string; code?: string; retryable?: boolean }; raw?: unknown };
export interface SendInputRequest { input: string | AgentMessage[]; idempotencyKey?: string; }

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  capabilities(): Promise<ProviderCapabilities> | ProviderCapabilities;
  health(): Promise<{ ok: boolean; detail?: string }>;
  createSession(request: CreateSessionRequest): Promise<AgentSession>;
  getSession(providerSessionId: string): Promise<AgentSession>;
  sendInput(providerSessionId: string, request: SendInputRequest): Promise<void>;
  cancel?(providerSessionId: string): Promise<void>;
}

export interface ProviderPluginContext { env: NodeJS.ProcessEnv; }
export interface ProviderPlugin {
  manifest: { id: string; name: string; version: string; protocolVersion: "1" };
  create(config: Record<string, unknown>, context: ProviderPluginContext): AgentProvider | Promise<AgentProvider>;
}
