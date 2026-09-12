import type {
  AgentProvider,
  CreateSessionRequest,
  ProviderCapabilities,
  ProviderPlugin,
  ProviderSession,
  SessionEventBatch,
  SessionStatus,
} from "@agent-gateway/protocol";

export interface OpenAIAgentsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
}

export class OpenAIAgentsProvider implements AgentProvider {
  readonly type = "openai-agents";
  readonly displayName = "OpenAI Agents API";
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAIAgentsProviderOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  capabilities(): ProviderCapabilities {
    const all = [
      "durable_session",
      "streaming",
      "sandbox",
      "mcp",
      "tools",
      "artifacts",
      "subagents",
      "approvals",
      "secrets",
      "files",
    ] as const;
    return { supported: [...all], native: [...all] };
  }

  async health() {
    return {
      ok: Boolean(this.options.apiKey),
      detail: this.options.apiKey ? undefined : "OpenAI API key is missing",
    };
  }

  private headers(accept?: string) {
    return {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      ...(accept ? { Accept: accept } : {}),
    };
  }

  private async json(path: string, init?: RequestInit) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenAI Agents API ${response.status}: ${text}`);
    return text ? JSON.parse(text) : undefined;
  }

  private mapStatus(status: unknown): SessionStatus {
    if (status === "idle" || status === "in_progress" || status === "requires_action" || status === "failed") {
      return status;
    }
    return "idle";
  }

  private map(raw: Record<string, any>): ProviderSession {
    return {
      providerSessionId: String(raw.id),
      status: this.mapStatus(raw.status),
      createdAt: new Date(Number(raw.created_at ?? Date.now() / 1000) * 1000).toISOString(),
      lastActiveAt: raw.last_active_at
        ? new Date(Number(raw.last_active_at) * 1000).toISOString()
        : undefined,
      metadata: raw.metadata,
      requiredActions: raw.required_actions,
      usage: raw.usage,
      raw,
    };
  }

  async createSession(request: CreateSessionRequest) {
    const agent = request.agent ? { ...request.agent } : undefined;
    if (agent && !agent.model && this.options.defaultModel) agent.model = this.options.defaultModel;

    const body: Record<string, unknown> = {
      agent,
      agent_id: request.agent_id,
      environment: request.environment ?? { type: "none" },
      input: request.input,
      metadata: request.metadata,
      vault_ids: request.vault_ids,
      stream: false,
    };
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];

    return this.map(
      await this.json("/agents/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
  }

  async getSession(providerSessionId: string) {
    return this.map(await this.json(`/agents/sessions/${encodeURIComponent(providerSessionId)}`));
  }

  async sendEvents(providerSessionId: string, request: SessionEventBatch) {
    await this.json(`/agents/sessions/${encodeURIComponent(providerSessionId)}/events`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async streamEvents(providerSessionId: string): Promise<AsyncIterable<Uint8Array>> {
    const response = await fetch(
      `${this.baseUrl}/agents/sessions/${encodeURIComponent(providerSessionId)}/events`,
      { headers: this.headers("text/event-stream") },
    );
    if (!response.ok) throw new Error(`OpenAI Agents API ${response.status}: ${await response.text()}`);
    if (!response.body) throw new Error("OpenAI Agents API returned an empty event stream");
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }
}

export const plugin: ProviderPlugin = {
  manifest: {
    id: "openai-agents",
    name: "OpenAI Agents API",
    version: "0.2.0",
    protocolVersion: "2",
  },
  create(config, context) {
    const apiKey = String(config.apiKey ?? context.env.OPENAI_API_KEY ?? "");
    return new OpenAIAgentsProvider({
      apiKey,
      baseUrl: String(config.baseUrl ?? context.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"),
      defaultModel: config.defaultModel
        ? String(config.defaultModel)
        : context.env.OPENAI_AGENT_MODEL || undefined,
    });
  },
};

export default plugin;
