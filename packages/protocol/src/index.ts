export type AgentCapability =
  | "durable_session"
  | "streaming"
  | "sandbox"
  | "mcp"
  | "tools"
  | "artifacts"
  | "subagents"
  | "approvals"
  | "secrets"
  | "files";

export interface ProviderCapabilities {
  supported: AgentCapability[];
  native: AgentCapability[];
  emulated?: AgentCapability[];
  limits?: Record<string, number | string | boolean>;
}

export type SessionStatus = "idle" | "in_progress" | "requires_action" | "failed" | "cancelled";

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export interface AgentEnvironment {
  type: string;
  [key: string]: unknown;
}

export interface AgentDefinition {
  model?: string;
  instructions?: string | null;
  name?: string | null;
  tools?: unknown[] | null;
  multi_agent?: { enabled: boolean; max_concurrent_subagents?: number } | null;
  reasoning?: Record<string, unknown> | null;
  service_tier?: string | null;
  text?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface SessionBudget {
  /**
   * Legacy numeric representation retained for internal/backward compatibility.
   * New northbound max-cost headers are normalized directly into max_cost_micros so
   * financial limits never pass through JavaScript floating-point arithmetic.
   */
  max_cost_usd?: number;
  max_cost_micros?: string;
  max_duration_seconds?: number;
  max_iterations?: number;
  max_subagents?: number;
}

/**
 * The canonical request intentionally follows the OpenAI Agents API session shape.
 * Gateway-only routing and budget policy are supplied out-of-band by the data plane.
 */
export interface CreateSessionRequest {
  agent?: AgentDefinition;
  agent_id?: string;
  environment?: AgentEnvironment;
  input?: string | AgentMessage[] | unknown[] | null;
  metadata?: Record<string, string> | null;
  vault_ids?: string[] | null;
  stream?: boolean;
}

export interface SessionEventBatch {
  events: unknown[];
  idempotency_key?: string;
}

export interface ProviderSession {
  providerSessionId: string;
  status: SessionStatus;
  createdAt: string;
  lastActiveAt?: string;
  metadata?: Record<string, string>;
  requiredActions?: unknown[];
  usage?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface GatewaySession extends Record<string, unknown> {
  id: string;
  object: string;
  status: SessionStatus;
  created_at: number;
  last_active_at?: number;
  metadata?: Record<string, string>;
  required_actions?: unknown[];
  usage?: Record<string, unknown>;
  gateway: {
    provider: string;
    channel: string;
  };
}

export interface AgentProvider {
  readonly type: string;
  readonly displayName: string;
  capabilities(): Promise<ProviderCapabilities> | ProviderCapabilities;
  health(): Promise<{ ok: boolean; detail?: string }>;
  createSession(request: CreateSessionRequest): Promise<ProviderSession>;
  getSession(providerSessionId: string): Promise<ProviderSession>;
  sendEvents(providerSessionId: string, request: SessionEventBatch): Promise<void>;
  streamEvents?(providerSessionId: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface ProviderPluginContext {
  env: NodeJS.ProcessEnv;
}

export interface ProviderPlugin {
  manifest: {
    id: string;
    name: string;
    version: string;
    protocolVersion: "2";
  };
  create(
    config: Record<string, unknown>,
    context: ProviderPluginContext,
  ): AgentProvider | Promise<AgentProvider>;
}
