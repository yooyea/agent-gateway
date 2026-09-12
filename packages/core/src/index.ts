import { randomUUID } from "node:crypto";
import type {
  AgentCapability,
  AgentProvider,
  CreateSessionRequest,
  GatewaySession,
  ProviderCapabilities,
  ProviderPlugin,
  ProviderSession,
  SessionBudget,
  SessionEventBatch,
} from "@agent-gateway/protocol";

export interface GatewayRequestContext {
  tenantId: string;
  projectId?: string;
  virtualKeyId?: string;
}

export interface RouteHints {
  provider?: string;
  channel?: string;
  requiredCapabilities?: AgentCapability[];
  budget?: SessionBudget;
}

export interface PluginConfigEntry {
  id: string;
  module: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  config?: Record<string, unknown>;
}

export interface ProviderChannel {
  id: string;
  provider: AgentProvider;
  enabled: boolean;
  priority: number;
  weight: number;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  virtualKeyId?: string;
  provider: string;
  channelId: string;
  providerSessionId: string;
  budget?: SessionBudget;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void> | void;
  get(id: string): Promise<SessionRecord | undefined> | SessionRecord | undefined;
  update(record: SessionRecord): Promise<void> | void;
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  create(record: SessionRecord) {
    if (this.records.has(record.id)) throw new Error(`Session already exists: ${record.id}`);
    this.records.set(record.id, { ...record });
  }
  get(id: string) {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }
  update(record: SessionRecord) {
    if (!this.records.has(record.id)) throw new Error(`Unknown session: ${record.id}`);
    this.records.set(record.id, { ...record });
  }
}

export class ProviderRegistry {
  private readonly channels = new Map<string, ProviderChannel>();

  register(channel: ProviderChannel) {
    if (this.channels.has(channel.id)) throw new Error(`Channel already registered: ${channel.id}`);
    this.channels.set(channel.id, channel);
    return this;
  }

  get(id: string) {
    const channel = this.channels.get(id);
    if (!channel) throw new Error(`Unknown channel: ${id}`);
    return channel;
  }

  list() {
    return [...this.channels.values()];
  }
}

export async function loadProviderPlugins(
  entries: PluginConfigEntry[],
  registry: ProviderRegistry,
  env: NodeJS.ProcessEnv = process.env,
) {
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const loaded = (await import(entry.module)) as { plugin?: ProviderPlugin; default?: ProviderPlugin };
    const plugin = loaded.plugin ?? loaded.default;
    if (!plugin?.manifest || typeof plugin.create !== "function") {
      throw new Error(`Invalid provider plugin: ${entry.module}`);
    }
    const provider = await plugin.create(entry.config ?? {}, { env });
    registry.register({
      id: entry.id,
      provider,
      enabled: true,
      priority: entry.priority ?? 100,
      weight: entry.weight ?? 100,
    });
  }
  return registry;
}

function supports(capabilities: ProviderCapabilities, required: AgentCapability[] = []) {
  const supported = new Set(capabilities.supported);
  return required.every((capability) => supported.has(capability));
}

function gatewaySession(record: SessionRecord, providerSession: ProviderSession): GatewaySession {
  const raw = providerSession.raw ?? {};
  const createdAt = Math.floor(new Date(providerSession.createdAt).getTime() / 1000);
  const lastActiveAt = providerSession.lastActiveAt
    ? Math.floor(new Date(providerSession.lastActiveAt).getTime() / 1000)
    : undefined;

  return {
    ...raw,
    id: record.id,
    object: typeof raw.object === "string" ? raw.object : "agent.session",
    status: providerSession.status,
    created_at: Number.isFinite(createdAt) ? createdAt : Math.floor(Date.now() / 1000),
    ...(lastActiveAt ? { last_active_at: lastActiveAt } : {}),
    ...(providerSession.metadata ? { metadata: providerSession.metadata } : {}),
    ...(providerSession.requiredActions ? { required_actions: providerSession.requiredActions } : {}),
    ...(providerSession.usage ? { usage: providerSession.usage } : {}),
    gateway: {
      provider: record.provider,
      channel: record.channelId,
    },
  };
}

export class AgentGateway {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly sessions: SessionStore = new InMemorySessionStore(),
    private readonly defaultProvider?: string,
  ) {}

  async channels() {
    return Promise.all(
      this.registry.list().map(async (channel) => ({
        id: channel.id,
        provider: channel.provider.type,
        displayName: channel.provider.displayName,
        enabled: channel.enabled,
        priority: channel.priority,
        weight: channel.weight,
        capabilities: await channel.provider.capabilities(),
        health: await channel.provider.health(),
      })),
    );
  }

  private async select(hints: RouteHints) {
    if (hints.channel) {
      const explicit = this.registry.get(hints.channel);
      if (!explicit.enabled) throw new Error(`Channel disabled: ${hints.channel}`);
      if (!supports(await explicit.provider.capabilities(), hints.requiredCapabilities)) {
        throw new Error(`Channel ${hints.channel} does not satisfy required capabilities`);
      }
      return explicit;
    }

    const provider = hints.provider ?? this.defaultProvider;
    const candidates = this.registry
      .list()
      .filter((channel) => channel.enabled && (!provider || channel.provider.type === provider));

    const eligible: ProviderChannel[] = [];
    for (const channel of candidates) {
      if (!(await channel.provider.health()).ok) continue;
      if (!supports(await channel.provider.capabilities(), hints.requiredCapabilities)) continue;
      eligible.push(channel);
    }

    if (!eligible.length) {
      const suffix = provider ? ` for provider ${provider}` : "";
      throw new Error(`No healthy channel satisfies routing policy${suffix}`);
    }

    eligible.sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.id.localeCompare(b.id));
    return eligible[0];
  }

  async createSession(
    request: CreateSessionRequest,
    context: GatewayRequestContext,
    hints: RouteHints = {},
  ): Promise<GatewaySession> {
    const channel = await this.select(hints);
    const providerSession = await channel.provider.createSession(request);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: `agsess_${randomUUID().replaceAll("-", "")}`,
      tenantId: context.tenantId,
      projectId: context.projectId,
      virtualKeyId: context.virtualKeyId,
      provider: channel.provider.type,
      channelId: channel.id,
      providerSessionId: providerSession.providerSessionId,
      budget: hints.budget,
      createdAt: now,
      updatedAt: now,
    };
    await this.sessions.create(record);
    return gatewaySession(record, providerSession);
  }

  private async resolve(id: string, context: GatewayRequestContext) {
    const record = await this.sessions.get(id);
    if (!record || record.tenantId !== context.tenantId) throw new Error(`Session not found: ${id}`);
    const channel = this.registry.get(record.channelId);
    return { record, channel };
  }

  async getSession(id: string, context: GatewayRequestContext) {
    const { record, channel } = await this.resolve(id, context);
    const providerSession = await channel.provider.getSession(record.providerSessionId);
    record.updatedAt = new Date().toISOString();
    await this.sessions.update(record);
    return gatewaySession(record, providerSession);
  }

  async sendEvents(id: string, request: SessionEventBatch, context: GatewayRequestContext) {
    const { record, channel } = await this.resolve(id, context);
    await channel.provider.sendEvents(record.providerSessionId, request);
    record.updatedAt = new Date().toISOString();
    await this.sessions.update(record);
  }

  async streamEvents(id: string, context: GatewayRequestContext) {
    const { record, channel } = await this.resolve(id, context);
    if (!channel.provider.streamEvents) {
      throw new Error(`Provider ${channel.provider.type} does not support event streaming`);
    }
    return channel.provider.streamEvents(record.providerSessionId);
  }
}

export interface VirtualKeyRecord {
  id: string;
  key: string;
  tenantId: string;
  projectId?: string;
  enabled?: boolean;
}

export class StaticVirtualKeyAuthenticator {
  private readonly keys: Map<string, VirtualKeyRecord>;
  constructor(records: VirtualKeyRecord[]) {
    this.keys = new Map(records.map((record) => [record.key, record]));
  }

  authenticate(authorization?: string): GatewayRequestContext {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new Error("Missing bearer token");
    const record = this.keys.get(token);
    if (!record || record.enabled === false) throw new Error("Invalid API key");
    return { tenantId: record.tenantId, projectId: record.projectId, virtualKeyId: record.id };
  }
}
