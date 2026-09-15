import http from "node:http";
import { randomUUID } from "node:crypto";
import type { CredentialKeyring } from "@agent-gateway/credential-crypto";
import {
  bootstrapActor,
  ControlPlaneAuthorizationError,
  secureTokenEqual,
  type ControlPlaneActor,
  type PostgresControlPlaneSecurity,
} from "@agent-gateway/control-plane-auth";
import {
  requireCommercialPermission,
  type CommercialPermission,
} from "@agent-gateway/control-plane-auth/commercial";
import {
  PostgresCommercialStore,
  type BillingInterval,
} from "@agent-gateway/commercial-postgres";
import { stableRequestHash } from "@agent-gateway/core";

export interface CommercialControlPlaneDependencies {
  commercial: PostgresCommercialStore;
  security: PostgresControlPlaneSecurity;
  credentialKeyring: CredentialKeyring;
  bootstrapToken?: string;
  idempotencyPendingTtlSeconds: number;
  idempotencyCompletedTtlSeconds: number;
}

function prefixedId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function readBearer(req: http.IncomingMessage) {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function requestId(req: http.IncomingMessage) {
  const raw = req.headers["x-request-id"];
  return typeof raw === "string" && raw.trim()
    ? raw.trim().slice(0, 256)
    : `req_${randomUUID().replaceAll("-", "")}`;
}

async function readJson(req: http.IncomingMessage) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function json(res: http.ServerResponse, status: number, body: unknown, requestId: string,
  headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function errorStatus(error: unknown) {
  if (error instanceof ControlPlaneAuthorizationError) return 403;
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid control plane token/.test(message)) return 401;
  if (/idempotency request is still in progress|idempotency key was already used/.test(message)) return 409;
  if (/Plan not found|Plan version not found|subscription not found|Cancelable subscription not found|Tenant not found/.test(message)) return 404;
  if (/overlapping subscription|not active|not effective/.test(message)) return 409;
  if (/must be|required|Invalid|Idempotency-Key|Only USD/.test(message)) return 400;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23503" || code === "23514") return 409;
  return 500;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeMicros(value: unknown, name: string) {
  const text = String(value ?? "0").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer string`);
  return text;
}

function positiveMicros(value: unknown, name: string) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || BigInt(text) <= 0n) throw new Error(`${name} must be a positive integer string`);
  return text;
}

function positiveInteger(value: unknown, name: string) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function billingInterval(value: unknown): BillingInterval {
  if (value === "month" || value === "year") return value;
  throw new Error("billing_interval must be month or year");
}

function idemContext(actorId: string, action: string, key: string) {
  return `agent-gateway:commercial-control-idempotency:${actorId}:scope:${action}:key:${key}`;
}

export function createCommercialControlPlaneHandler(deps: CommercialControlPlaneDependencies) {
  const {
    commercial, security, credentialKeyring, bootstrapToken,
    idempotencyPendingTtlSeconds, idempotencyCompletedTtlSeconds,
  } = deps;

  security.attachTransactionalPool(commercial.pool);

  async function authenticate(req: http.IncomingMessage): Promise<ControlPlaneActor> {
    const token = readBearer(req);
    if (!token) throw new Error("Invalid control plane token");
    if (bootstrapToken && secureTokenEqual(token, bootstrapToken)) return bootstrapActor();
    const actor = await security.authenticateToken(token);
    if (!actor) throw new Error("Invalid control plane token");
    return actor;
  }

  async function audit(input: {
    actor: ControlPlaneActor;
    requestId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
    outcome: "success" | "denied" | "error";
    metadata?: Record<string, unknown>;
  }) {
    await security.appendAudit({
      id: prefixedId("agaud"), actor: input.actor, requestId: input.requestId,
      action: input.action, resourceType: input.resourceType, resourceId: input.resourceId,
      tenantId: input.tenantId, outcome: input.outcome, metadata: input.metadata,
    });
  }

  async function authorize(input: {
    actor: ControlPlaneActor;
    requestId: string;
    permission: CommercialPermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
  }) {
    try {
      requireCommercialPermission(input.actor, input.permission, input.tenantId);
    } catch (error) {
      await audit({ ...input, outcome: "denied", metadata: { permission: input.permission } }).catch(() => undefined);
      throw error;
    }
  }

  async function mutation<T>(input: {
    req: http.IncomingMessage;
    actor: ControlPlaneActor;
    requestId: string;
    permission: CommercialPermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
    request: unknown;
    status: number;
    run: () => Promise<T>;
    resultResourceId?: (result: T) => string | undefined;
  }) {
    await authorize(input);
    let key = "";
    let requestHash = "";
    let claimed = false;
    try {
      const raw = input.req.headers["idempotency-key"];
      key = typeof raw === "string" ? raw.trim() : "";
      if (!key) throw new Error("Idempotency-Key is required for commercial mutations");
      if (key.length > 256) throw new Error("Idempotency-Key must be at most 256 characters");
      requestHash = stableRequestHash(input.request);
      const context = idemContext(input.actor.id, input.action, key);
      const claim = await security.claimControlIdempotency({
        actorId: input.actor.id, scope: input.action, key, requestHash,
        expiresAt: new Date(Date.now() + idempotencyPendingTtlSeconds * 1000).toISOString(),
      });
      if (claim.state === "conflict") throw new Error("Control plane idempotency key was already used with a different request");
      if (claim.state === "in_progress") throw new Error("Control plane idempotency request is still in progress");
      if (claim.state === "replay") {
        const replay = credentialKeyring.decrypt<{ status: number; body: T }>(claim.responseEnvelope, context);
        await audit({
          actor: input.actor, requestId: input.requestId, action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(replay.body) ?? input.resourceId,
          tenantId: input.tenantId, outcome: "success", metadata: { idempotent_replay: true },
        });
        return { status: replay.status, body: replay.body, replay: true };
      }
      claimed = true;
      const body = await security.withTransaction(async () => {
        const result = await input.run();
        await audit({
          actor: input.actor, requestId: input.requestId, action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(result) ?? input.resourceId,
          tenantId: input.tenantId, outcome: "success",
        });
        const envelope = credentialKeyring.encrypt({ status: input.status, body: result }, context);
        await security.completeControlIdempotency({
          actorId: input.actor.id, scope: input.action, key, requestHash,
          responseStatus: input.status, responseEnvelope: envelope.envelope,
          expiresAt: new Date(Date.now() + idempotencyCompletedTtlSeconds * 1000).toISOString(),
        });
        return result;
      });
      return { status: input.status, body, replay: false };
    } catch (error) {
      if (claimed) {
        await security.releaseControlIdempotency({ actorId: input.actor.id, scope: input.action, key, requestHash })
          .catch(() => undefined);
      }
      await audit({
        actor: input.actor, requestId: input.requestId, action: input.action,
        resourceType: input.resourceType, resourceId: input.resourceId,
        tenantId: input.tenantId, outcome: "error",
        metadata: { error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function read<T>(input: {
    actor: ControlPlaneActor;
    requestId: string;
    permission: CommercialPermission;
    action: string;
    resourceType: string;
    tenantId?: string;
    run: () => Promise<T>;
  }) {
    await authorize(input);
    const body = await input.run();
    await audit({
      actor: input.actor, requestId: input.requestId, action: input.action,
      resourceType: input.resourceType, tenantId: input.tenantId, outcome: "success",
    });
    return body;
  }

  return async function handleCommercialControlPlane(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
    if (!path.startsWith("/api/gateway/admin/commercial/")) return false;
    const rid = requestId(req);
    try {
      const actor = await authenticate(req);
      const url = new URL(req.url ?? path, `http://${req.headers.host ?? "localhost"}`);

      if (path === "/api/gateway/admin/commercial/plans" && req.method === "GET") {
        const body = await read({ actor, requestId: rid, permission: "commercial.plans.read",
          action: "commercial.plan.list", resourceType: "plan", run: () => commercial.listPlans() });
        json(res, 200, body, rid); return true;
      }

      if (path === "/api/gateway/admin/commercial/plans" && req.method === "POST") {
        const request = await readJson(req) as Record<string, unknown>;
        const name = optionalString(request.name);
        if (!name) throw new Error("name is required");
        const normalized = { name, description: optionalString(request.description) };
        const result = await mutation({ req, actor, requestId: rid, permission: "commercial.plans.write",
          action: "commercial.plan.create", resourceType: "plan", request: normalized, status: 201,
          run: () => commercial.createPlan(normalized), resultResourceId: (value: any) => value?.id });
        json(res, result.status, result.body, rid, result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      let match = path.match(/^\/api\/gateway\/admin\/commercial\/plans\/([^/]+)\/versions$/);
      if (match && req.method === "GET") {
        const planId = decodeURIComponent(match[1]);
        const body = await read({ actor, requestId: rid, permission: "commercial.plans.read",
          action: "commercial.plan_version.list", resourceType: "plan_version",
          run: () => commercial.listPlanVersions(planId) });
        json(res, 200, body, rid); return true;
      }

      if (match && req.method === "POST") {
        const planId = decodeURIComponent(match[1]);
        const request = await readJson(req) as Record<string, unknown>;
        const currency = optionalString(request.currency) ?? "USD";
        if (currency !== "USD") throw new Error("Only USD commercial plans are currently supported");
        const normalized = {
          planId,
          currency,
          billingInterval: billingInterval(request.billing_interval),
          recurringPriceMicros: nonNegativeMicros(request.recurring_price_micros, "recurring_price_micros"),
          includedCreditMicros: nonNegativeMicros(request.included_credit_micros, "included_credit_micros"),
          defaultSessionBudgetMicros: request.default_session_budget_micros == null
            ? undefined : positiveMicros(request.default_session_budget_micros, "default_session_budget_micros"),
          requestsPerMinute: positiveInteger(request.requests_per_minute, "requests_per_minute"),
          maxConcurrency: positiveInteger(request.max_concurrency, "max_concurrency"),
          entitlements: request.entitlements && typeof request.entitlements === "object" && !Array.isArray(request.entitlements)
            ? request.entitlements as Record<string, unknown> : {},
          effectiveFrom: optionalString(request.effective_from),
        };
        const result = await mutation({ req, actor, requestId: rid, permission: "commercial.plans.write",
          action: "commercial.plan_version.create", resourceType: "plan_version", resourceId: planId,
          request: normalized, status: 201, run: () => commercial.createPlanVersion(normalized),
          resultResourceId: (value: any) => value?.id });
        json(res, result.status, result.body, rid, result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      if (path === "/api/gateway/admin/commercial/subscriptions" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        const body = await read({ actor, requestId: rid, permission: "commercial.subscriptions.read",
          action: "commercial.subscription.list", resourceType: "subscription", tenantId,
          run: () => commercial.listSubscriptions(tenantId) });
        json(res, 200, body, rid); return true;
      }

      if (path === "/api/gateway/admin/commercial/subscriptions" && req.method === "POST") {
        const request = await readJson(req) as Record<string, unknown>;
        const tenantId = optionalString(request.tenant_id);
        const planVersionId = optionalString(request.plan_version_id);
        if (!tenantId) throw new Error("tenant_id is required");
        if (!planVersionId) throw new Error("plan_version_id is required");
        const normalized = { tenantId, planVersionId, startsAt: optionalString(request.starts_at), endsAt: optionalString(request.ends_at) };
        const result = await mutation({ req, actor, requestId: rid, permission: "commercial.subscriptions.write",
          action: "commercial.subscription.create", resourceType: "subscription", tenantId,
          request: normalized, status: 201, run: () => commercial.createSubscription(normalized),
          resultResourceId: (value: any) => value?.id });
        json(res, result.status, result.body, rid, result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/commercial\/subscriptions\/([^/]+)\/cancel$/);
      if (match && req.method === "POST") {
        const id = decodeURIComponent(match[1]);
        const lookup = await commercial.pool.query(`SELECT tenant_id FROM gateway_subscriptions WHERE id=$1`, [id]);
        if (!lookup.rows[0]) throw new Error(`subscription not found: ${id}`);
        const tenantId = String(lookup.rows[0].tenant_id);
        const result = await mutation({ req, actor, requestId: rid, permission: "commercial.subscriptions.write",
          action: "commercial.subscription.cancel", resourceType: "subscription", resourceId: id, tenantId,
          request: { id }, status: 200, run: () => commercial.cancelSubscription(id),
          resultResourceId: (value: any) => value?.id });
        json(res, result.status, result.body, rid, result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      if (path === "/api/gateway/admin/commercial/policy" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        if (!tenantId) throw new Error("tenant_id is required");
        const body = await read({ actor, requestId: rid, permission: "commercial.policy.read",
          action: "commercial.policy.read", resourceType: "commercial_policy", tenantId,
          run: () => commercial.resolvePolicy(tenantId) });
        json(res, 200, body ?? null, rid); return true;
      }

      json(res, 404, { error: { type: "not_found", message: "Commercial Control Plane route not found" } }, rid);
      return true;
    } catch (error) {
      json(res, errorStatus(error), { error: { type: "gateway_error", message: error instanceof Error ? error.message : String(error) } }, rid);
      return true;
    }
  };
}
