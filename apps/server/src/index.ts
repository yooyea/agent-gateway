import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AgentGateway,
  hashVirtualKey,
  InMemoryIdempotencyStore,
  InMemorySessionStore,
  loadProviderPlugins,
  ProviderRegistry,
  stableRequestHash,
  StaticVirtualKeyAuthenticator,
  StoreBackedVirtualKeyAuthenticator,
  type GatewayAuthenticator,
  type GatewayRequestContext,
  type IdempotencyStore,
  type PluginConfigEntry,
  type RouteHints,
  type SessionStore,
  type VirtualKeyRecord,
} from "@agent-gateway/core";
import { RedisRuntimeControls } from "@agent-gateway/runtime-redis";
import { PostgresGatewayStore } from "@agent-gateway/storage-postgres";
import type { AgentCapability, CreateSessionRequest, SessionEventBatch } from "@agent-gateway/protocol";

interface GatewayConfig {
  defaultProvider?: string;
  channels: PluginConfigEntry[];
}

interface ControlPlaneStore {
  createTenant(input: { id: string; name: string }): Promise<unknown>;
  createProject(input: { id: string; tenantId: string; name: string }): Promise<unknown>;
  createVirtualKey(input: {
    id: string;
    tenantId: string;
    projectId?: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    expiresAt?: string;
  }): Promise<unknown>;
}

class GatewayAdmissionError extends Error {
  constructor(
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GatewayAdmissionError";
  }
}

async function loadConfig(): Promise<GatewayConfig> {
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

  return {
    defaultProvider: process.env.DEFAULT_PROVIDER ?? (process.env.OPENAI_API_KEY ? "openai-agents" : "mock"),
    channels,
  };
}

function loadStaticKeys(): VirtualKeyRecord[] {
  const configured = process.env.AGENT_GATEWAY_KEYS;
  if (configured) return JSON.parse(configured);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL or AGENT_GATEWAY_KEYS is required in production");
  }
  return [
    {
      id: "vk_dev",
      key: process.env.AGENT_GATEWAY_DEV_KEY ?? "ag_dev_local",
      tenantId: "tenant_dev",
      projectId: "project_dev",
      enabled: true,
    },
  ];
}

function envPositiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function safeTokenEqual(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminToken(req: http.IncomingMessage) {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function requireAdmin(req: http.IncomingMessage) {
  const expected = process.env.AGENT_GATEWAY_ADMIN_TOKEN ??
    (process.env.NODE_ENV === "production" ? undefined : "admin_dev_local");
  if (!expected) throw new Error("Control plane admin token is not configured");
  if (!safeTokenEqual(adminToken(req), expected)) throw new Error("Invalid admin token");
}

function prefixedId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function createVirtualKeySecret() {
  return `ag_${randomBytes(32).toString("base64url")}`;
}

async function createPersistence(): Promise<{
  sessions: SessionStore;
  idempotency: IdempotencyStore;
  authenticator: GatewayAuthenticator;
  control?: ControlPlaneStore;
  database?: PostgresGatewayStore;
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
  const autoMigrate = process.env.AGENT_GATEWAY_AUTO_MIGRATE === "true" ||
    (process.env.AGENT_GATEWAY_AUTO_MIGRATE !== "false" && process.env.NODE_ENV !== "production");
  if (autoMigrate) await store.migrate();

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
    control: store,
    database: store,
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

const cfg = await loadConfig();
const registry = await loadProviderPlugins(cfg.channels, new ProviderRegistry());
const persistence = await createPersistence();
const runtimeControls = await createRuntimeControls();
const sessionCacheTtlSeconds = envPositiveInteger("AGENT_GATEWAY_SESSION_CACHE_TTL_SECONDS", 300);
const sessions = runtimeControls
  ? runtimeControls.createCachedSessionStore(persistence.sessions, sessionCacheTtlSeconds)
  : persistence.sessions;
const gateway = new AgentGateway(registry, sessions, cfg.defaultProvider, runtimeControls);
const port = Number(process.env.PORT ?? 8787);
const idempotencyPendingTtlSeconds = envPositiveInteger("AGENT_GATEWAY_IDEMPOTENCY_PENDING_TTL_SECONDS", 900);
const idempotencyCompletedTtlSeconds = envPositiveInteger("AGENT_GATEWAY_IDEMPOTENCY_TTL_SECONDS", 86400);
const rateLimitRequests = envPositiveInteger("AGENT_GATEWAY_RATE_LIMIT_REQUESTS", 120);
const rateLimitWindowSeconds = envPositiveInteger("AGENT_GATEWAY_RATE_LIMIT_WINDOW_SECONDS", 60);
const maxConcurrency = envPositiveInteger("AGENT_GATEWAY_MAX_CONCURRENCY", 20);
const concurrencyLeaseSeconds = envPositiveInteger("AGENT_GATEWAY_CONCURRENCY_LEASE_SECONDS", 300);

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
  if (error instanceof GatewayAdmissionError) return 429;
  const message = error instanceof Error ? error.message : String(error);
  if (/Missing bearer token|Invalid API key|Invalid admin token/.test(message)) return 401;
  if (/admin token is not configured/.test(message)) return 503;
  if (/Session not found/.test(message)) return 404;
  if (/Session is not bound|Idempotency request is still in progress|Idempotency key was already used/.test(message)) return 409;
  if (/Channel circuit is open|No healthy channel/.test(message)) return 503;
  if (/Unknown channel|does not satisfy|must be|required/.test(message)) return 400;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23503") return 409;
  return 500;
}

function routeHints(req: http.IncomingMessage): RouteHints {
  const provider = req.headers["x-agent-gateway-provider"];
  const channel = req.headers["x-agent-gateway-channel"];
  const capabilityHeader = req.headers["x-agent-gateway-required-capabilities"];
  const maxCostHeader = req.headers["x-agent-gateway-max-cost-usd"];

  const requiredCapabilities = typeof capabilityHeader === "string"
    ? capabilityHeader.split(",").map((item) => item.trim()).filter(Boolean) as AgentCapability[]
    : undefined;
  const maxCostUsd = typeof maxCostHeader === "string" ? Number(maxCostHeader) : undefined;

  return {
    provider: typeof provider === "string" ? provider : undefined,
    channel: typeof channel === "string" ? channel : undefined,
    requiredCapabilities,
    budget: Number.isFinite(maxCostUsd) ? { max_cost_usd: maxCostUsd } : undefined,
  };
}

function runtimeIdentity(context: GatewayRequestContext) {
  return `${context.tenantId}:${context.virtualKeyId ?? context.projectId ?? "tenant"}`;
}

async function enforceRateLimit(context: GatewayRequestContext) {
  if (!runtimeControls) return {} as Record<string, string>;
  const decision = await runtimeControls.checkRateLimit({
    key: runtimeIdentity(context),
    limit: rateLimitRequests,
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

async function withConcurrency<T>(context: GatewayRequestContext, run: () => Promise<T>): Promise<T> {
  if (!runtimeControls) return run();
  const decision = await runtimeControls.acquireConcurrency({
    key: runtimeIdentity(context),
    limit: maxConcurrency,
    ttlSeconds: concurrencyLeaseSeconds,
  });
  if (!decision.acquired) {
    throw new GatewayAdmissionError("Concurrency limit exceeded", {
      "retry-after": String(decision.retryAfterSeconds),
      "x-agent-gateway-limit-type": "concurrency",
      "x-agent-gateway-concurrency-limit": String(maxConcurrency),
    });
  }

  const heartbeatMs = Math.max(1000, Math.floor((concurrencyLeaseSeconds * 1000) / 3));
  const heartbeat = setInterval(() => {
    void runtimeControls.renewConcurrency(decision.lease, concurrencyLeaseSeconds).catch(() => undefined);
  }, heartbeatMs);
  heartbeat.unref();

  try {
    return await run();
  } finally {
    clearInterval(heartbeat);
    await runtimeControls.releaseConcurrency(decision.lease).catch(() => undefined);
  }
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

  const claim = await persistence.idempotency.claim({
    tenantId: input.context.tenantId,
    virtualKeyId: input.context.virtualKeyId,
    scope: input.scope,
    key,
    requestHash: stableRequestHash(input.request),
    expiresAt: new Date(Date.now() + idempotencyPendingTtlSeconds * 1000).toISOString(),
  });

  if (claim.state === "conflict") throw new Error("Idempotency key was already used with a different request");
  if (claim.state === "in_progress") throw new Error("Idempotency request is still in progress");
  if (claim.state === "replay") {
    return { status: claim.responseStatus, body: claim.responseBody as T, replay: true };
  }

  const result = await input.run();
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

async function handleControlPlane(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
  if (!path.startsWith("/api/gateway/admin/")) return false;
  requireAdmin(req);
  if (!persistence.control) throw new Error("Persistent control plane requires DATABASE_URL");

  if (req.method === "POST" && path === "/api/gateway/admin/tenants") {
    const body = await readJson(req) as { name?: string };
    if (!body.name?.trim()) throw new Error("Tenant name is required");
    const tenant = await persistence.control.createTenant({ id: prefixedId("tenant"), name: body.name.trim() });
    json(res, 201, tenant);
    return true;
  }

  if (req.method === "POST" && path === "/api/gateway/admin/projects") {
    const body = await readJson(req) as { tenant_id?: string; name?: string };
    if (!body.tenant_id?.trim() || !body.name?.trim()) throw new Error("tenant_id and project name are required");
    const project = await persistence.control.createProject({
      id: prefixedId("project"),
      tenantId: body.tenant_id.trim(),
      name: body.name.trim(),
    });
    json(res, 201, project);
    return true;
  }

  if (req.method === "POST" && path === "/api/gateway/admin/virtual-keys") {
    const body = await readJson(req) as {
      tenant_id?: string;
      project_id?: string;
      name?: string;
      expires_at?: string;
    };
    if (!body.tenant_id?.trim() || !body.name?.trim()) throw new Error("tenant_id and key name are required");
    if (body.expires_at && !Number.isFinite(new Date(body.expires_at).getTime())) {
      throw new Error("expires_at must be a valid date-time");
    }
    const secret = createVirtualKeySecret();
    const record = await persistence.control.createVirtualKey({
      id: prefixedId("vk"),
      tenantId: body.tenant_id.trim(),
      projectId: body.project_id?.trim() || undefined,
      name: body.name.trim(),
      keyHash: hashVirtualKey(secret),
      keyPrefix: secret.slice(0, 10),
      expiresAt: body.expires_at,
    });
    json(res, 201, { ...record as Record<string, unknown>, key: secret });
    return true;
  }

  json(res, 404, { error: { type: "not_found", message: "Control plane route not found" } });
  return true;
}

http
  .createServer(async (req, res) => {
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
          database,
          redis,
        });
      }

      if (await handleControlPlane(req, res, path)) return;

      const context = await persistence.authenticator.authenticate(req.headers.authorization);
      const rateHeaders = await enforceRateLimit(context);

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
        const hints = routeHints(req);
        const result = await executeIdempotent({
          req,
          context,
          scope: "agents.sessions.create",
          request: { body, hints },
          run: async () => ({
            status: 201,
            body: await withConcurrency(context, () => gateway.createSession(body, context, hints)),
          }),
        });
        return json(res, result.status, result.body, {
          ...rateHeaders,
          ...(result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {}),
        });
      }

      let match = path.match(/^\/agents\/sessions\/([^/]+)$/);
      if (req.method === "GET" && match) {
        const session = await withConcurrency(context, () => gateway.getSession(decodeURIComponent(match![1]), context));
        return json(res, 200, session, rateHeaders);
      }

      match = path.match(/^\/agents\/sessions\/([^/]+)\/events$/);
      if (req.method === "POST" && match) {
        const sessionId = decodeURIComponent(match[1]);
        const events = (await readJson(req)) as SessionEventBatch;
        await withConcurrency(context, () => gateway.sendEvents(sessionId, events, context));
        res.writeHead(204, rateHeaders);
        return res.end();
      }

      if (req.method === "GET" && match) {
        const sessionId = decodeURIComponent(match[1]);
        await withConcurrency(context, async () => {
          const stream = await gateway.streamEvents(sessionId, context);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            ...rateHeaders,
          });
          for await (const chunk of stream) res.write(chunk);
          res.end();
        });
        return;
      }

      return json(res, 404, { error: { type: "not_found", message: "Route not found" } }, rateHeaders);
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const headers = error instanceof GatewayAdmissionError ? error.headers : {};
      return json(res, errorStatus(error), { error: { type: "gateway_error", message } }, headers);
    }
  })
  .listen(port, () => console.log(`agent-gateway listening on :${port}`));
