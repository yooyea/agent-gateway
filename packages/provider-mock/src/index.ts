import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  CreateSessionRequest,
  ProviderCapabilities,
  ProviderPlugin,
  ProviderSession,
  SessionEventBatch,
} from "@agent-gateway/protocol";

export class MockProvider implements AgentProvider {
  readonly type = "mock";
  readonly displayName = "Mock Agent Provider";
  private readonly sessions = new Map<string, ProviderSession>();

  capabilities(): ProviderCapabilities {
    return {
      supported: ["durable_session", "streaming", "tools"],
      native: ["durable_session", "streaming", "tools"],
    };
  }

  async health() {
    return { ok: true };
  }

  async createSession(request: CreateSessionRequest) {
    const providerSessionId = `mock_${randomUUID().replaceAll("-", "")}`;
    const createdAt = new Date().toISOString();
    const raw = {
      id: providerSessionId,
      object: "agent.session",
      status: "idle",
      created_at: Math.floor(new Date(createdAt).getTime() / 1000),
      last_active_at: Math.floor(new Date(createdAt).getTime() / 1000),
      agent: request.agent ?? { model: "mock" },
      environment: request.environment ?? { type: "none" },
      metadata: request.metadata ?? {},
      required_actions: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      vault_ids: request.vault_ids ?? [],
    };
    const session: ProviderSession = {
      providerSessionId,
      status: "idle",
      createdAt,
      lastActiveAt: createdAt,
      metadata: request.metadata ?? undefined,
      requiredActions: [],
      usage: raw.usage,
      raw,
    };
    this.sessions.set(providerSessionId, session);
    return session;
  }

  async getSession(providerSessionId: string) {
    const session = this.sessions.get(providerSessionId);
    if (!session) throw new Error("Mock session not found");
    return session;
  }

  async sendEvents(providerSessionId: string, _request: SessionEventBatch) {
    const session = await this.getSession(providerSessionId);
    const now = new Date();
    session.status = "idle";
    session.lastActiveAt = now.toISOString();
    if (session.raw) {
      session.raw.status = "idle";
      session.raw.last_active_at = Math.floor(now.getTime() / 1000);
    }
  }

  async streamEvents(providerSessionId: string): Promise<AsyncIterable<Uint8Array>> {
    await this.getSession(providerSessionId);
    const encoder = new TextEncoder();
    return (async function* () {
      yield encoder.encode(`event: agent.session.mock\ndata: {"type":"agent.session.mock"}\n\n`);
    })();
  }
}

export const plugin: ProviderPlugin = {
  manifest: {
    id: "mock",
    name: "Mock Agent Provider",
    version: "0.2.0",
    protocolVersion: "2",
  },
  create() {
    return new MockProvider();
  },
};

export default plugin;
