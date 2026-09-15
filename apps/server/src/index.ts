import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentGateway,
  InMemoryIdempotencyStore,
  InMemorySessionStore,
  ProviderRegistry,
  stableRequestHash,
  StaticVirtualKeyAuthenticator,
  StoreBackedVirtualKeyAuthenticator,
  type GatewayAuthenticator,
  type GatewayRequestContext,
  type IdempotencyStore,
  type PluginConfigEntry,
  type ProviderChannel,
  type RouteHints,
  type SessionStore,
  type VirtualKeyRecord,
} from "@agent-gateway/core";
import {
  BillingInsufficientFundsError,
  BillingPricingUnavailableError,
  BillingSessionStore,
  DataPlaneBilling,
  PostgresDataPlaneBillingStore,
  SessionBudgetExceededError,
  SessionBudgetRequiredError,
  usdToMicros,
} from "@agent-gateway/billing-runtime";
import { PostgresControlPlaneSecurity } from "@agent-gateway/control-plane-auth";
import { PostgresCommercialStore, type CommercialPolicy } from "@agent-gateway/commercial-postgres";
import { CredentialKeyring, credentialContext } from "@agent-gateway/credential-crypto";
import { RedisRuntimeControls } from "@agent-gateway/runtime-redis";
import { PostgresGatewayStore, type RuntimeChannelRecord } from "@agent-gateway/storage-postgres";
import type {
  AgentCapability,
  CreateSessionRequest,
  GatewaySession,
  ProviderPlugin,
  SessionEventBatch,
} from "@agent-gateway/protocol";
import { createBillingControlPlaneHandler } from "./billing-control-plane.js";
import { createCommercialControlPlaneHandler } from "./commercial-control-plane.js";
import { createControlPlaneHandler } from "./control-plane.js";
import {
  applyCommercialSessionBudget,
  resolveRuntimeAdmission,
  runtimeAdmissionKey,
  type RuntimeAdmissionPolicy,
} from "./commercial-runtime.js";

interface GatewayConfig {
  defaultProvider?: string;
  channels: PluginConfigEntry[];
}

class GatewayAdmissionError extends Error {
  constructor(message: string, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = "GatewayAdmissionError";
  }
}

const DEV_CREDENTIAL_KEY = "YWdlbnQtZ2F0ZXdheS1kZXYta2V5LTMyLWJ5dGVzISE=";
const BUILTIN_PROVIDER_MODULES: Record<string, string> = {
  "openai-agents": "@agent-gateway/provider-openai-agents",
  mock: "@agent-gateway/provider-mock",
};

function providerModules() {
  const custom = process.env.AGENT_GATEWAY_PROVIDER_PLUGINS
    ? JSON.parse(process.env.AGENT_GATEWAY_PROVIDER_PLUGINS) as Record<string, string>
    : {};
  return { ...BUILTIN_PROVIDER_MODULES, ...custom };
}

async function loadFallbackConfig(): Promise<GatewayConfig> {
  if (process.env.AGENT_GATEWAY_CONFIG) {
    return JSON.parse(await readFile(process.env.AGENT_GATEWAY_CONFIG, "utf8"));
  }
  const channels: PluginConfigEntry[] = [
    { id: "mock-default", module: "@agent-gateway/provider-mock", enabled: true, priority: 1000 },
  ];
  if (process.env.OPENAI_API_KEY) {
    channels.unshift({
      id: "openai-default",
      module: "@agent-gateway/provider-openai-agents",
      enabled: true,
      priority: 100,
    });
  }
  return { defaultProvider: process.env.DEFAULT_PROVIDER?.trim() || undefined, channels };
}

function loadStaticKeys(): VirtualKeyRecord[] {
  const configured = process.env.AGENT_GATEWAY_KEYS;
  if (configured) return JSON.parse(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL or AGENT_GATEWAY_KEYS is required in production");
  }
  return [{
    id: "vk_dev",
    key: process.env.AGENT_GATEWAY_DEV_KEY ?? "ag_dev_local",
    tenantId: "tenant_dev",
    projectId: "project_dev",
    enabled: true,
  }];
}

function envPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function createCredentialKeyring() {
  if (process.env.AGENT_GATEWAY_CREDENTIAL_KEYS && process.env.AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID) {
    return CredentialKeyring.fromEnvironment();
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Credential encryption keys are required in production");
  }
  return new CredentialKeyring({ dev: DEV_CREDENTIAL_KEY }, "dev");
}

async function createPersistence(): Promise<{
  sessions: SessionStore;
  idempotency: IdempotencyStore;
  authenticator: GatewayAuthenticator;
  database?: PostgresGatewayStore;
  controlSecurity?: PostgresControlPlaneSecurity;
  billing?: PostgresDataPlaneBillingStore;
  commercial?: PostgresCommercialStore;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    return {
      sessions: new InMemorySessionStore(),
      idempotency: new InMemoryIdempotencyStore(),
      authenticator: new StaticVirtualKeyAuthenticator(loadStaticKeys()),
    };
  }

  const store = new PostgresGatewayStore(databaseUrl);
  const controlSecurity = new PostgresControlPlaneSecurity(databaseUrl);
  const reservationTtlSeconds = envPositiveInteger(
    "AGENT_GATEWAY_SESSION_RESERVATION_TTL_SECONDS",
    86_400,
  );
  const billing = new PostgresDataPlaneBillingStore(databaseUrl, {
    reservationRenewalTtlSeconds: reservationTtlSeconds,
  });
  const commercial = new PostgresCommercialStore(databaseUrl);
  controlSecurity.attachTransactionalPool(store.pool);

  const autoMigrate = process.env.AGENT_GATEWAY_AUTO_MIGRATE === "true" ||
    (process.env.AGENT_GATEWAY_AUTO_MIGRATE !== "false" && process.env.NODE_ENV !== "production");
  if (autoMigrate) {
    await store.migrate();
    await controlSecurity.migrate();
    await billing.migrate();
    await commercial.migrate();
  }
  if (process.env.AGENT_GATEWAY_DEV_BOOTSTRAP === "true") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AGENT_GATEWAY_DEV_BOOTSTRAP must not be enabled in production");
    }
    await store.seedDevelopmentIdentity({
      tenantId: "tenant_dev",
      projectId: "project_dev",
      virtualKeyId: "vk_dev",
      secret: process.env.AGENT_GATEWAY_DEV_KEY ?? "ag_dev_local",
    });
  }
  return {
    sessions: store,
    idempotency: store,
    authenticator: new StoreBackedVirtualKeyAuthenticator(store),
    database: store,
    controlSecurity,
    billing,
    commercial,
  };
}

async function createRuntimeControls() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (process.env.NODE_ENV === "production") throw new Error("REDIS_URL is required in production");
    return undefined;
  }
  return RedisRuntimeControls.connect(redisUrl, {
    keyPrefix: process.env.AGENT_GATEWAY_REDIS_PREFIX ?? "agent-gateway",
    circuitFailureThreshold: envPositiveInteger("AGENT_GATEWAY_CIRCUIT_FAILURE_THRESHOLD", 3),
    circuitFailureWindowSeconds: envPositiveInteger("AGENT_GATEWAY_CIRCUIT_FAILURE_WINDOW_SECONDS", 60),
    circuitOpenSeconds: envPositiveInteger("AGENT_GATEWAY_CIRCUIT_OPEN_SECONDS", 30),
  });
}

async function pluginFromModule(module: string): Promise<ProviderPlugin> {
  const loaded = await import(module) as { plugin?: ProviderPlugin; default?: ProviderPlugin };
  const plugin = loaded.plugin ?? loaded.default;
  if (!plugin?.manifest || typeof plugin.create !== "function") {
    throw new Error(`Invalid provider plugin: ${module}`);
  }
  return plugin;
}

async function registerEntry(
  registry: ProviderRegistry,
  entry: PluginConfigEntry,
  config = entry.config ?? {},
) {
  const plugin = await pluginFromModule(entry.module);
  const provider = await plugin.create(config, { env: process.env });
  const channel: ProviderChannel = {
    id: entry.id,
    provider,
    enabled: entry.enabled !== false,
    priority: entry.priority ?? 100,
    weight: entry.weight ?? 100,
  };
  registry.register(channel);
}

const persistence = await createPersistence();
const runtimeControls = await createRuntimeControls();
const credentialKeyring = createCredentialKeyring();
const sessionCacheTtlSeconds = envPositiveInteger("AGENT_GATEWAY_SESSION_CACHE_TTL_SECONDS", 300);
const sessionReservationTtlSeconds = envPositiveInteger(
  "AGENT_GATEWAY_SESSION_RESERVATION_TTL_SECONDS",
  86_400,
);
const billingSessions = persistence.billing
  ? new BillingSessionStore(persistence.sessions, persistence.billing, {
    reservationTtlSeconds: sessionReservationTtlSeconds,
    requireBudgetForBilledTenant: true,
  })
  : persistence.sessions;
const sessions = runtimeControls
  ? runtimeControls.createCachedSessionStore(billingSessions, sessionCacheTtlSeconds)
  : billingSessions;
const dataPlaneBilling = persistence.billing ? new DataPlaneBilling(persistence.billing) : undefined;
const moduleCatalog = providerModules();
const defaultProvider = process.env.DEFAULT_PROVIDER?.trim() || undefined;

async function seedDevelopmentRuntime() {
  const store = persistence.database;
  if (!store || process.env.AGENT_GATEWAY_DEV_BOOTSTRAP !== "true") return;
  const mockProviderId = "agprov_dev_mock";
  await store.upsertProvider({
    id: mockProviderId,
    type: "mock",
    displayName: "Mock Agent Provider",
    enabled: true,
  });
  await store.upsertChannel({
    id: "mock-default",
    providerId: mockProviderId,
    name: "Mock default",
    enabled: true,
    priority: 1000,
    weight: 100,
  });

  if (process.env.OPENAI_API_KEY) {
    const providerId = "agprov_dev_openai";
    const credentialId = "agcred_dev_openai";
    await store.upsertProvider({
      id: providerId,
      type: "openai-agents",
      displayName: "OpenAI Agents API",
      enabled: true,
    });
    const encrypted = credentialKeyring.encrypt(
      { apiKey: process.env.OPENAI_API_KEY },
      credentialContext(credentialId, providerId),
    );
    await store.upsertCredential({
      id: credentialId,
      providerId,
      name: "Development OpenAI key",
      kind: "api_key",
      encryptedPayload: encrypted.envelope,
      encryptionKeyId: encrypted.keyId,
      algorithm: encrypted.algorithm,
    });
    await store.upsertChannel({
      id: "openai-default",
      providerId,
      credentialId,
      name: "OpenAI default",
      enabled: true,
      priority: 100,
      weight: 100,
      config: {
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        ...(process.env.OPENAI_AGENT_MODEL ? { defaultModel: process.env.OPENAI_AGENT_MODEL } : {}),
      },
    });
  }
}

await seedDevelopmentRuntime();

async function registryFromPersistentChannels(rows: RuntimeChannelRecord[]) {
  const registry = new ProviderRegistry();
  for (const row of rows) {
    const module = moduleCatalog[row.providerType];
    if (!module) throw new Error(`Unknown provider type: ${row.providerType}`);
    const credentialPayload = row.credential
      ? credentialKeyring.decrypt(
        row.credential.encryptedPayload,
        credentialContext(row.credential.id, row.providerId),
      )
      : {};
    await registerEntry(
      registry,
      {
        id: row.id,
        module,
        enabled: row.providerEnabled && row.enabled,
        priority: row.priority,
        weight: row.weight,
      },
      { ...row.providerConfig, ...row.config, ...credentialPayload },
    );
  }
  return registry;
}

async function buildGateway() {
  let registry: ProviderRegistry;
  if (persistence.database) {
    registry = await registryFromPersistentChannels(await persistence.database.listRuntimeChannels());
  } else {
    const cfg = await loadFallbackConfig();
    registry = new ProviderRegistry();
    for (const entry of cfg.channels) await registerEntry(registry, entry);
  }
  return new AgentGateway(registry, sessions, defaultProvider, runtimeControls);
}

let gateway = await buildGateway();
async function reloadGateway() {
  gateway = await buildGateway();
}

const port = Number(process.env.PORT ?? 8787);
const idempotencyPendingTtlSeconds = envPositiveInteger("AGENT_GATEWAY_IDEMPOTENCY_PENDING_TTL_SECONDS", 900);
const idempotencyCompletedTtlSeconds = envPositiveInteger("AGENT_GATEWAY_IDEMPOTENCY_TTL_SECONDS", 86400);
const rateLimitRequests = envPositiveInteger("AGENT_GATEWAY_RATE_LIMIT_REQUESTS", 120);
const rateLimitWindowSeconds = envPositiveInteger("AGENT_GATEWAY_RATE_LIMIT_WINDOW_SECONDS", 60);
const maxConcurrency = envPositiveInteger("AGENT_GATEWAY_MAX_CONCURRENCY", 20);
const concurrencyLeaseSeconds = envPositiveInteger("AGENT_GATEWAY_CONCURRENCY_LEASE_SECONDS", 300);

const bootstrapToken = process.env.AGENT_GATEWAY_ADMIN_TOKEN ??
  (process.env.NODE_ENV === "production" ? undefined : "admin_dev_local");

const controlPlaneHandler = persistence.database && persistence.controlSecurity
  ? createControlPlaneHandler({
    store: persistence.database,
    security: persistence.controlSecurity,
    credentialKeyring,
    moduleCatalog,
    reloadGateway,
    bootstrapToken,
    idempotencyPendingTtlSeconds,
    idempotencyCompletedTtlSeconds,
  })
  : undefined;

const billingControlPlaneHandler = persistence.billing && persistence.controlSecurity
  ? createBillingControlPlaneHandler({
    billing: persistence.billing,
    security: persistence.controlSecurity,
    credentialKeyring,
    bootstrapToken,
    idempotencyPendingTtlSeconds,
    idempotencyCompletedTtlSeconds,
  })
  : undefined;

const commercialControlPlaneHandler = persistence.commercial && persistence.controlSecurity
  ? createCommercialControlPlaneHandler({
    commercial: persistence.commercial,
    security: persistence.controlSecurity,
    credentialKeyring,
    bootstrapToken,
    idempotencyPendingTtlSeconds,
    idempotencyCompletedTtlSeconds,
  })
  : undefined;

async function readJson(req: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function errorStatus(error: unknown) {
  if (error instanceof BillingInsufficientFundsError) return 402;
  if (error instanceof SessionBudgetRequiredError) return 402;
  if (error instanceof SessionBudgetExceededError) return 429;
  if (error instanceof BillingPricingUnavailableError) return 503;
  if (error instanceof GatewayAdmissionError) return 429;
  const message = error instanceof Error ? error.message : String(error);
  if (/Billing account disabled/.test(message)) return 402;
  if (/Missing bearer token|Invalid API key/.test(message)) return 401;
  if (/Session not found|Provider not found|Credential not found|Channel not found/.test(message)) return 404;
  if (/Session is not bound|Idempotency request is still in progress|Idempotency key was already used/.test(message)) return 409;
  if (/Channel circuit is open|No healthy channel/.test(message)) return 503;
  if (/Unknown channel|Unknown provider type|does not satisfy|must be|required|Sensitive field/.test(message)) return 400;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23503" || code === "23514") return 409;
  return 500;
}

function errorHeaders(error: unknown) {
  if (error instanceof GatewayAdmissionError) return error.headers;
  if (error instanceof BillingInsufficientFundsError) {
    return {
      "x-agent-gateway-limit-type": "billing_capacity",
      "x-agent-gateway-available-micros": error.availableMicros.toString(),
      "x-agent-gateway-requested-micros": error.requestedMicros.toString(),
    };
  }
  if (error instanceof SessionBudgetRequiredError) {
    return { "x-agent-gateway-limit-type": "budget_required" };
  }
  if (error instanceof SessionBudgetExceededError) {
    return {
      "x-agent-gateway-limit-type": "budget",
      "x-agent-gateway-budget-remaining-micros": error.remainingMicros.toString(),
    };
  }
  if (error instanceof BillingPricingUnavailableError) {
    return {
      "x-agent-gateway-limit-type": "billing_price_unavailable",
      ...(error.usageEventId ? { "x-agent-gateway-usage-event-id": error.usageEventId } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/Billing account disabled/.test(message)) {
    return { "x-agent-gateway-limit-type": "billing_disabled" };
  }
  return {} as Record<string, string>;
}

function routeHints(req: http.IncomingMessage): RouteHints {
  const provider = req.headers["x-agent-gateway-provider"];
  const channel = req.headers["x-agent-gateway-channel"];
  const capabilityHeader = req.headers["x-agent-gateway-required-capabilities"];
  const maxCostHeader = req.headers["x-agent-gateway-max-cost-usd"];
  const requiredCapabilities = typeof capabilityHeader === "string"
    ? capabilityHeader.split(",").map((item) => item.trim()).filter(Boolean) as AgentCapability[]
    : undefined;

  let maxCostMicros: string | undefined;
  if (typeof maxCostHeader === "string") {
    const raw = maxCostHeader.trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(raw)) {
      throw new Error("X-Agent-Gateway-Max-Cost-USD must be a positive decimal with at most 6 fractional digits");
    }
    const micros = usdToMicros(raw);
    if (micros <= 0n) {
      throw new Error("X-Agent-Gateway-Max-Cost-USD must be greater than zero");
    }
    maxCostMicros = micros.toString();
  }

  return {
    provider: typeof provider === "string" ? provider : undefined,
    channel: typeof channel === "string" ? channel : undefined,
    requiredCapabilities,
    budget: maxCostMicros === undefined ? undefined : { max_cost_micros: maxCostMicros },
  };
}

function runtimeIdentity(context: GatewayRequestContext) {
  return `${context.tenantId}:${context.virtualKeyId ?? context.projectId ?? "tenant"}`;
}

async function resolveCommercialPolicy(context: GatewayRequestContext): Promise<CommercialPolicy | undefined> {
  return persistence.commercial?.resolvePolicy(context.tenantId);
}

async function enforceRateLimit(context: GatewayRequestContext, admission: RuntimeAdmissionPolicy) {
  if (!runtimeControls) return {} as Record<string, string>;
  const admissionKey = runtimeAdmissionKey(context.tenantId, runtimeIdentity(context), admission);
  const decision = await runtimeControls.checkRateLimit({
    key: admissionKey,
    limit: admission.requestsPerMinute,
    windowSeconds: rateLimitWindowSeconds,
  });
  const headers = {
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-agent-gateway-ratelimit-reset-after": String(decision.resetAfterSeconds),
  };
  if (!decision.allowed) {
    throw new GatewayAdmissionError("Rate limit exceeded", {
      ...headers,
      "retry-after": String(Math.max(1, decision.resetAfterSeconds)),
      "x-agent-gateway-limit-type": "rate",
    });
  }
  return headers;
}

async function withLease<T>(input: {
  key: string;
  limit: number;
  limitType: string;
  run: () => Promise<T>;
}): Promise<T> {
  if (!runtimeControls) return input.run();
  const decision = await runtimeControls.acquireConcurrency({
    key: input.key,
    limit: input.limit,
    ttlSeconds: concurrencyLeaseSeconds,
  });
  if (!decision.acquired) {
    throw new GatewayAdmissionError("Concurrency limit exceeded", {
      "retry-after": String(decision.retryAfterSeconds),
      "x-agent-gateway-limit-type": input.limitType,
      "x-agent-gateway-concurrency-limit": String(input.limit),
    });
  }
  const heartbeatMs = Math.max(1000, Math.floor((concurrencyLeaseSeconds * 1000) / 3));
  const heartbeat = setInterval(() => {
    void runtimeControls.renewConcurrency(decision.lease, concurrencyLeaseSeconds).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();
  try {
    return await input.run();
  } finally {
    clearInterval(heartbeat);
    await runtimeControls.releaseConcurrency(decision.lease).catch(() => undefined);
  }
}

function withConcurrency<T>(
  context: GatewayRequestContext,
  admission: RuntimeAdmissionPolicy,
  run: () => Promise<T>,
) {
  return withLease({
    key: runtimeAdmissionKey(context.tenantId, runtimeIdentity(context), admission),
    limit: admission.maxConcurrency,
    limitType: "concurrency",
    run,
  });
}

function withSessionConcurrency<T>(sessionId: string, run: () => Promise<T>) {
  return withLease({
    key: `session:${sessionId}`,
    limit: 1,
    limitType: "session_concurrency",
    run,
  });
}

async function releaseDataPlaneIdempotency(input: {
  context: GatewayRequestContext;
  scope: string;
  key: string;
  requestHash: string;
}) {
  if (!persistence.database || !input.context.virtualKeyId) return;
  await persistence.database.pool.query(
    `DELETE FROM gateway_idempotency
     WHERE tenant_id=$1 AND virtual_key_id=$2 AND scope=$3 AND idempotency_key=$4
       AND request_hash=$5 AND state='pending'`,
    [input.context.tenantId, input.context.virtualKeyId, input.scope, input.key, input.requestHash],
  );
}

function knownPreProviderFailure(error: unknown) {
  if (error instanceof BillingInsufficientFundsError) return true;
  if (error instanceof SessionBudgetRequiredError) return true;
  if (error instanceof GatewayAdmissionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Billing account disabled/.test(message);
}

async function executeIdempotent<T>(input: {
  req: http.IncomingMessage;
  context: GatewayRequestContext;
  scope: string;
  request: unknown;
  run: () => Promise<{ status: number; body: T }>;
}) {
  const header = input.req.headers["idempotency-key"];
  const key = typeof header === "string" ? header.trim() : undefined;
  if (!key) return { ...(await input.run()), replay: false };
  if (key.length > 256) throw new Error("Idempotency-Key must be at most 256 characters");
  if (!input.context.virtualKeyId) throw new Error("Virtual key identity is required for idempotency");

  const requestHash = stableRequestHash(input.request);
  const claim = await persistence.idempotency.claim({
    tenantId: input.context.tenantId,
    virtualKeyId: input.context.virtualKeyId,
    scope: input.scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + idempotencyPendingTtlSeconds * 1000).toISOString(),
  });
  if (claim.state === "conflict") {
    throw new Error("Idempotency key was already used with a different request");
  }
  if (claim.state === "in_progress") throw new Error("Idempotency request is still in progress");
  if (claim.state === "replay") {
    return { status: claim.responseStatus, body: claim.responseBody as T, replay: true };
  }

  let result: { status: number; body: T };
  try {
    result = await input.run();
  } catch (error) {
    if (knownPreProviderFailure(error)) {
      await releaseDataPlaneIdempotency({
        context: input.context,
        scope: input.scope,
        key,
        requestHash,
      }).catch(() => undefined);
    }
    throw error;
  }

  await persistence.idempotency.complete({
    tenantId: input.context.tenantId,
    virtualKeyId: input.context.virtualKeyId,
    scope: input.scope,
    key,
    responseStatus: result.status,
    responseBody: result.body,
    expiresAt: new Date(Date.now() + idempotencyCompletedTtlSeconds * 1000).toISOString(),
  });
  return { ...result, replay: false };
}

async function scopedSessionContext(sessionId: string, context: GatewayRequestContext) {
  const record = await sessions.get(sessionId);
  if (!record || record.tenantId !== context.tenantId) throw new Error(`Session not found: ${sessionId}`);
  if (context.projectId && record.projectId !== context.projectId) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return {
    ...context,
    projectId: record.projectId ?? context.projectId,
  };
}

async function observeSessionUsage(
  session: GatewaySession,
  context: GatewayRequestContext,
  modelHint?: string,
) {
  if (!dataPlaneBilling) return;
  await dataPlaneBilling.observeSession(session, context, { modelHint });
}

async function observeSessionUsageBestEffort(
  session: GatewaySession,
  context: GatewayRequestContext,
  modelHint?: string,
) {
  try {
    await observeSessionUsage(session, context, modelHint);
  } catch (error) {
    console.error("data-plane usage observation failed", error);
  }
}

async function assertBudgetBeforeProviderWork(sessionId: string, context: GatewayRequestContext) {
  if (!dataPlaneBilling) return;
  const snapshot = await gateway.getSession(sessionId, context);
  await observeSessionUsage(snapshot, context);
  await dataPlaneBilling.assertSessionBudget(sessionId);
}

async function reconcileSessionUsageBestEffort(sessionId: string, context: GatewayRequestContext) {
  if (!dataPlaneBilling) return;
  try {
    const snapshot = await gateway.getSession(sessionId, context);
    await observeSessionUsage(snapshot, context);
  } catch (error) {
    console.error("data-plane usage reconciliation failed", error);
  }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      const database = persistence.database ? await persistence.database.health() : undefined;
      const redis = runtimeControls ? await runtimeControls.health() : undefined;
      const ok = (database?.ok ?? true) && (redis?.ok ?? true);
      return json(res, ok ? 200 : 503, {
        ok,
        service: "agent-gateway",
        persistence: database ? "postgres" : "memory",
        runtime: redis ? "redis" : "disabled",
        billing: persistence.billing ? "postgres" : "disabled",
        commercial: persistence.commercial ? "postgres" : "disabled",
        database,
        redis,
      });
    }

    if (path.startsWith("/api/gateway/admin/")) {
      if (!controlPlaneHandler) {
        return json(res, 503, {
          error: {
            type: "gateway_error",
            message: "Control plane security requires DATABASE_URL",
          },
        }, { "x-request-id": `req_${randomUUID().replaceAll("-", "")}` });
      }
      if (billingControlPlaneHandler && path.startsWith("/api/gateway/admin/billing/")) {
        if (await billingControlPlaneHandler(req, res, path)) return;
      }
      if (commercialControlPlaneHandler && path.startsWith("/api/gateway/admin/commercial/")) {
        if (await commercialControlPlaneHandler(req, res, path)) return;
      }
      if (await controlPlaneHandler(req, res, path)) return;
    }

    const context = await persistence.authenticator.authenticate(req.headers.authorization);
    const commercialPolicy = await resolveCommercialPolicy(context);
    const admission = resolveRuntimeAdmission(commercialPolicy, {
      requestsPerMinute: rateLimitRequests,
      maxConcurrency,
    });
    const rateHeaders = await enforceRateLimit(context, admission);

    if (req.method === "GET" && path === "/api/gateway/channels") {
      return json(res, 200, await gateway.channels(), rateHeaders);
    }

    if (req.method === "POST" && path === "/agents/sessions") {
      const body = (await readJson(req)) as CreateSessionRequest;
      if (body.stream === true) {
        return json(res, 501, {
          error: {
            type: "gateway_not_implemented",
            message: "Streaming session creation is not implemented yet; create with stream=false then use the events stream endpoint.",
          },
        }, rateHeaders);
      }
      const hints = applyCommercialSessionBudget(routeHints(req), commercialPolicy);
      const result = await executeIdempotent({
        req,
        context,
        scope: "agents.sessions.create",
        request: { body, hints },
        run: async () => {
          const session = await withConcurrency(
            context,
            admission,
            () => gateway.createSession(body, context, hints),
          );
          await observeSessionUsageBestEffort(session, context, body.agent?.model);
          return { status: 201, body: session };
        },
      });
      return json(res, result.status, result.body, {
        ...rateHeaders,
        ...(result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {}),
      });
    }

    let match = path.match(/^\/agents\/sessions\/([^/]+)$/);
    if (req.method === "GET" && match) {
      const sessionId = decodeURIComponent(match[1]);
      const sessionContext = await scopedSessionContext(sessionId, context);
      const session = await withConcurrency(
        sessionContext,
        admission,
        () => gateway.getSession(sessionId, sessionContext),
      );
      await observeSessionUsageBestEffort(session, sessionContext);
      return json(res, 200, session, rateHeaders);
    }

    match = path.match(/^\/agents\/sessions\/([^/]+)\/events$/);
    if (req.method === "POST" && match) {
      const sessionId = decodeURIComponent(match[1]);
      const sessionContext = await scopedSessionContext(sessionId, context);
      const events = (await readJson(req)) as SessionEventBatch;
      await withConcurrency(sessionContext, admission, () => withSessionConcurrency(sessionId, async () => {
        await assertBudgetBeforeProviderWork(sessionId, sessionContext);
        await gateway.sendEvents(sessionId, events, sessionContext);
        await reconcileSessionUsageBestEffort(sessionId, sessionContext);
      }));
      res.writeHead(204, rateHeaders);
      return res.end();
    }

    if (req.method === "GET" && match) {
      const sessionId = decodeURIComponent(match[1]);
      const sessionContext = await scopedSessionContext(sessionId, context);
      await withConcurrency(sessionContext, admission, () => withSessionConcurrency(sessionId, async () => {
        await assertBudgetBeforeProviderWork(sessionId, sessionContext);
        const stream = await gateway.streamEvents(sessionId, sessionContext);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          ...rateHeaders,
        });
        try {
          for await (const chunk of stream) res.write(chunk);
          res.end();
        } finally {
          await reconcileSessionUsageBestEffort(sessionId, sessionContext);
        }
      }));
      return;
    }

    return json(res, 404, { error: { type: "not_found", message: "Route not found" } }, rateHeaders);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    return json(
      res,
      errorStatus(error),
      { error: { type: "gateway_error", message } },
      errorHeaders(error),
    );
  }
}).listen(port, () => console.log(`agent-gateway listening on :${port}`));
