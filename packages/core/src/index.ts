import { createHash, randomUUID } from "node:crypto";
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

export type SessionBindingState = "creating" | "bound" | "failed";

export interface SessionRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  virtualKeyId?: string;
  provider: string;
  channelId: string;
  providerSessionId?: string;
  state: SessionBindingState;
  lastError?: string;
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
    this.records.set(record.id, structuredClone(record));
  }

  get(id: string) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  update(record: SessionRecord) {
    if (!this.records.has(record.id)) throw new Error(`Unknown session: ${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }
}

export interface ChannelRuntimeState {
  /**
   * Used only when assigning new sessions. Existing bound sessions never migrate
   * merely because a circuit is open.
   */
  isChannelAvailable(channelId: string): Promise<boolean>;
  recordChannelSuccess(channelId: string): Promise<void>;
  recordChannelFailure(channelId: string): Promise<void>;
}

export interface VirtualKeyIdentity {
  id: string;
  tenantId: string;
  projectId?: string;
  enabled: boolean;
  expiresAt?: string;
}

export interface VirtualKeyLookupStore {
  findVirtualKeyByHash(keyHash: string): Promise<VirtualKeyIdentity | undefined>;
}

export interface VirtualKeyRecord extends VirtualKeyIdentity {
  key: string;
}

export function hashVirtualKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface GatewayAuthenticator {
  authenticate(authorization?: string): Promise<GatewayRequestContext> | GatewayRequestContext;
}

function bearerToken(authorization?: string) {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) throw new Error("Missing bearer token");
  return token;
}

export class StoreBackedVirtualKeyAuthenticator implements GatewayAuthenticator {
  constructor(private readonly store: VirtualKeyLookupStore) {}

  async authenticate(authorization?: string): Promise<GatewayRequestContext> {
    const token = bearerToken(authorization);
    const record = await this.store.findVirtualKeyByHash(hashVirtualKey(token));
    if (!record || !record.enabled) throw new Error("Invalid API key");
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new Error("Invalid API key");
    }
    return { tenantId: record.tenantId, projectId: record.projectId, virtualKeyId: record.id };
  }
}

export class StaticVirtualKeyAuthenticator implements GatewayAuthenticator {
  private readonly keys: Map<string, VirtualKeyRecord>;

  constructor(records: VirtualKeyRecord[]) {
    this.keys = new Map(records.map((record) => [record.key, record]));
  }

  authenticate(authorization?: string): GatewayRequestContext {
    const token = bearerToken(authorization);
    const record = this.keys.get(token);
    if (!record || !record.enabled) throw new Error("Invalid API key");
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new Error("Invalid API key");
    }
    return { tenantId: record.tenantId, projectId: record.projectId, virtualKeyId: record.id };
  }
}

export interface IdempotencyClaimInput {
  tenantId: string;
  virtualKeyId: string;
  scope: string;
  key: string;
  requestHash: string;
  expiresAt: string;
}

export type IdempotencyClaimResult =
  | { state: "claimed" }
  | { state: "replay"; responseStatus: number; responseBody: unknown }
  | { state: "conflict" }
  | { state: "in_progress" };

export interface IdempotencyStore {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  complete(input: {
    tenantId: string;
    virtualKeyId: string;
    scope: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
    expiresAt?: string;
  }): Promise<void>;
}

interface MemoryIdempotencyRecord extends IdempotencyClaimInput {
  state: "pending" | "completed";
  responseStatus?: number;
  responseBody?: unknown;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, MemoryIdempotencyRecord>();

  private compound(input: Pick<IdempotencyClaimInput, "tenantId" | "virtualKeyId" | "scope" | "key">) {
    return `${input.tenantId}\u0000${input.virtualKeyId}\u0000${input.scope}\u0000${input.key}`;
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const key = this.compound(input);
    const existing = this.records.get(key);
    if (existing && new Date(existing.expiresAt).getTime() <= Date.now()) this.records.delete(key);
    const current = this.records.get(key);
    if (!current) {
      this.records.set(key, { ...structuredClone(input), state: "pending" });
      return { state: "claimed" };
    }
    if (current.requestHash !== input.requestHash) return { state: "conflict" };
    if (current.state === "completed") {
      return {
        state: "replay",
        responseStatus: current.responseStatus ?? 200,
        responseBody: structuredClone(current.responseBody),
      };
    }
    return { state: "in_progress" };
  }

  async complete(input: {
    tenantId: string;
    virtualKeyId: string;
    scope: string;
    key: string;
    responseStatus: number;
    responseBody: unknown;
    expiresAt?: string;
  }) {
    const key = this.compound(input);
    const current = this.records.get(key);
    if (!current) throw new Error("Idempotency claim not found");
    current.state = "completed";
    current.responseStatus = input.responseStatus;
    current.responseBody = structuredClone(input.responseBody);
    if (input.expiresAt) current.expiresAt = input.expiresAt;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function stableRequestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
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
    private readonly runtime?: ChannelRuntimeState,
  ) {}

  private async channelAvailable(channelId: string) {
    if (!this.runtime) return true;
    try {
      return await this.runtime.isChannelAvailable(channelId);
    } catch {
      // Circuit state is operational acceleration, not durable routing truth.
      return true;
    }
  }

  private async recordChannelSuccess(channelId: string) {
    try {
      await this.runtime?.recordChannelSuccess(channelId);
    } catch {
      // Provider success must not be hidden by runtime-state telemetry failure.
    }
  }

  private async recordChannelFailure(channelId: string) {
    try {
      await this.runtime?.recordChannelFailure(channelId);
    } catch {
      // The original provider error remains authoritative.
    }
  }

  async channels() {
    return Promise.all(
      this.registry.list().map(async (channel) => ({
        id: channel.id,
        provider: channel.provider.type,
        displayName: channel.provider.displayName,
        enabled: channel.enabled,
        priority: channel.priority,
        weight: channel.weight,
        circuitOpen: !(await this.channelAvailable(channel.id)),
        capabilities: await channel.provider.capabilities(),
        health: await channel.provider.health(),
      })),
    );
  }

  private async select(hints: RouteHints) {
    if (hints.channel) {
      const explicit = this.registry.get(hints.channel);
      if (!explicit.enabled) throw new Error(`Channel disabled: ${hints.channel}`);
      if (!(await this.channelAvailable(explicit.id))) throw new Error(`Channel circuit is open: ${hints.channel}`);
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
      if (!(await this.channelAvailable(channel.id))) continue;
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
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: `agsess_${randomUUID().replaceAll("-", "")}`,
      tenantId: context.tenantId,
      projectId: context.projectId,
      virtualKeyId: context.virtualKeyId,
      provider: channel.provider.type,
      channelId: channel.id,
      state: "creating",
      budget: hints.budget,
      createdAt: now,
      updatedAt: now,
    };

    await this.sessions.create(record);

    try {
      const providerSession = await channel.provider.createSession(request);
      await this.recordChannelSuccess(channel.id);
      record.providerSessionId = providerSession.providerSessionId;
      record.state = "bound";
      record.updatedAt = new Date().toISOString();
      await this.sessions.update(record);
      return gatewaySession(record, providerSession);
    } catch (error) {
      await this.recordChannelFailure(channel.id);
      record.state = "failed";
      record.lastError = error instanceof Error ? error.message : String(error);
      record.updatedAt = new Date().toISOString();
      await this.sessions.update(record);
      throw error;
    }
  }

  private async resolve(id: string, context: GatewayRequestContext) {
    const record = await this.sessions.get(id);
    if (!record || record.tenantId !== context.tenantId) throw new Error(`Session not found: ${id}`);
    if (record.state !== "bound" || !record.providerSessionId) {
      throw new Error(`Session is not bound: ${id} (${record.state})`);
    }
    const channel = this.registry.get(record.channelId);
    return { record, channel, providerSessionId: record.providerSessionId };
  }

  async getSession(id: string, context: GatewayRequestContext) {
    const { record, channel, providerSessionId } = await this.resolve(id, context);
    try {
      const providerSession = await channel.provider.getSession(providerSessionId);
      await this.recordChannelSuccess(channel.id);
      record.updatedAt = new Date().toISOString();
      await this.sessions.update(record);
      return gatewaySession(record, providerSession);
    } catch (error) {
      await this.recordChannelFailure(channel.id);
      throw error;
    }
  }

  async sendEvents(id: string, request: SessionEventBatch, context: GatewayRequestContext) {
    const { record, channel, providerSessionId } = await this.resolve(id, context);
    try {
      await channel.provider.sendEvents(providerSessionId, request);
      await this.recordChannelSuccess(channel.id);
      record.updatedAt = new Date().toISOString();
      await this.sessions.update(record);
    } catch (error) {
      await this.recordChannelFailure(channel.id);
      throw error;
    }
  }

  async streamEvents(id: string, context: GatewayRequestContext) {
    const { channel, providerSessionId } = await this.resolve(id, context);
    if (!channel.provider.streamEvents) {
      throw new Error(`Provider ${channel.provider.type} does not support event streaming`);
    }

    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = await channel.provider.streamEvents(providerSessionId);
    } catch (error) {
      await this.recordChannelFailure(channel.id);
      throw error;
    }

    const runtime = this.runtime;
    const channelId = channel.id;
    return (async function* () {
      try {
        for await (const chunk of stream) yield chunk;
        try {
          await runtime?.recordChannelSuccess(channelId);
        } catch {
          // A completed provider stream remains successful if runtime state is unavailable.
        }
      } catch (error) {
        try {
          await runtime?.recordChannelFailure(channelId);
        } catch {
          // Preserve the provider stream error.
        }
        throw error;
      }
    })();
  }
}
