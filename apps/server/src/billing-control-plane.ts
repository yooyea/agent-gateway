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
  hasBillingPermission,
  requireBillingPermission,
  type BillingPermission,
} from "@agent-gateway/control-plane-auth/billing";
import {
  PostgresBillingStore,
  type LedgerBook,
  type UsageMetric,
} from "@agent-gateway/billing-postgres";
import { stableRequestHash } from "@agent-gateway/core";

export interface BillingControlPlaneDependencies {
  billing: PostgresBillingStore;
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

function json(
  res: http.ServerResponse,
  status: number,
  data: unknown,
  rid: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": rid,
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function errorStatus(error: unknown) {
  if (error instanceof ControlPlaneAuthorizationError) return 403;
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid control plane token/.test(message)) return 401;
  if (/idempotency request is still in progress|idempotency key was already used/.test(message)) return 409;
  if (/Billing account not found/.test(message)) return 404;
  if (/must be|required|Invalid|Idempotency-Key/.test(message)) return 400;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23503" || code === "23514") return 409;
  return 500;
}

function positiveIntegerString(value: unknown, name: string, allowZero = false) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be an integer string`);
  const parsed = BigInt(text);
  if (allowZero ? parsed < 0n : parsed <= 0n) {
    throw new Error(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
  }
  return text;
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseMetric(value: unknown): UsageMetric {
  const allowed: UsageMetric[] = [
    "model.input_tokens",
    "model.cached_input_tokens",
    "model.output_tokens",
    "sandbox.compute_seconds",
    "web_search.call",
    "file_search.call",
    "tool.call",
    "provider.other",
  ];
  if (typeof value === "string" && allowed.includes(value as UsageMetric)) return value as UsageMetric;
  throw new Error("Invalid billing metric");
}

function parseBook(value: string | null): LedgerBook | undefined {
  if (!value) return undefined;
  if (value === "customer" || value === "upstream") return value;
  throw new Error("Invalid ledger book");
}

function parseLimit(raw: string | null, fallback = 100) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  return value;
}

function idemContext(actorId: string, scope: string, key: string) {
  return `agent-gateway:billing-control-idempotency:${actorId}:scope:${scope}:key:${key}`;
}

export function createBillingControlPlaneHandler(deps: BillingControlPlaneDependencies) {
  const {
    billing,
    security,
    credentialKeyring,
    bootstrapToken,
    idempotencyPendingTtlSeconds,
    idempotencyCompletedTtlSeconds,
  } = deps;

  security.attachTransactionalPool(billing.pool);

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
      id: prefixedId("agaud"),
      actor: input.actor,
      requestId: input.requestId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      tenantId: input.tenantId,
      outcome: input.outcome,
      metadata: input.metadata,
    });
  }

  async function authorize(input: {
    actor: ControlPlaneActor;
    requestId: string;
    permission: BillingPermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
  }) {
    try {
      requireBillingPermission(input.actor, input.permission, input.tenantId);
    } catch (error) {
      await audit({
        actor: input.actor,
        requestId: input.requestId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        tenantId: input.tenantId,
        outcome: "denied",
        metadata: { permission: input.permission },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function mutation<T>(input: {
    req: http.IncomingMessage;
    actor: ControlPlaneActor;
    requestId: string;
    permission: BillingPermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
    request: unknown;
    status: number;
    run: (idempotencyKey: string) => Promise<T>;
    resultResourceId?: (result: T) => string | undefined;
  }) {
    await authorize(input);

    let key = "";
    let requestHash = "";
    let claimed = false;
    try {
      const raw = input.req.headers["idempotency-key"];
      key = typeof raw === "string" ? raw.trim() : "";
      if (!key) throw new Error("Idempotency-Key is required for billing mutations");
      if (key.length > 256) throw new Error("Idempotency-Key must be at most 256 characters");

      requestHash = stableRequestHash(input.request);
      const context = idemContext(input.actor.id, input.action, key);
      const claim = await security.claimControlIdempotency({
        actorId: input.actor.id,
        scope: input.action,
        key,
        requestHash,
        expiresAt: new Date(Date.now() + idempotencyPendingTtlSeconds * 1000).toISOString(),
      });
      if (claim.state === "conflict") {
        throw new Error("Control plane idempotency key was already used with a different request");
      }
      if (claim.state === "in_progress") {
        throw new Error("Control plane idempotency request is still in progress");
      }
      if (claim.state === "replay") {
        const replay = credentialKeyring.decrypt<{ status: number; body: T }>(claim.responseEnvelope, context);
        await audit({
          actor: input.actor,
          requestId: input.requestId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(replay.body) ?? input.resourceId,
          tenantId: input.tenantId,
          outcome: "success",
          metadata: { idempotent_replay: true },
        });
        return { status: replay.status, body: replay.body, replay: true };
      }
      claimed = true;

      const body = await security.withTransaction(async () => {
        const result = await input.run(key);
        await audit({
          actor: input.actor,
          requestId: input.requestId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(result) ?? input.resourceId,
          tenantId: input.tenantId,
          outcome: "success",
        });
        const encrypted = credentialKeyring.encrypt({ status: input.status, body: result }, context);
        await security.completeControlIdempotency({
          actorId: input.actor.id,
          scope: input.action,
          key,
          requestHash,
          responseStatus: input.status,
          responseEnvelope: encrypted.envelope,
          expiresAt: new Date(Date.now() + idempotencyCompletedTtlSeconds * 1000).toISOString(),
        });
        return result;
      });
      return { status: input.status, body, replay: false };
    } catch (error) {
      if (claimed) {
        await security.releaseControlIdempotency({
          actorId: input.actor.id,
          scope: input.action,
          key,
          requestHash,
        }).catch(() => undefined);
      }
      await audit({
        actor: input.actor,
        requestId: input.requestId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        tenantId: input.tenantId,
        outcome: "error",
        metadata: { error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function auditedRead<T>(input: {
    actor: ControlPlaneActor;
    requestId: string;
    permission: BillingPermission;
    action: string;
    resourceType: string;
    tenantId?: string;
    run: () => Promise<T>;
  }) {
    await authorize(input);
    const body = await input.run();
    await audit({
      actor: input.actor,
      requestId: input.requestId,
      action: input.action,
      resourceType: input.resourceType,
      tenantId: input.tenantId,
      outcome: "success",
    });
    return body;
  }

  return async function handleBillingControlPlane(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ) {
    if (!path.startsWith("/api/gateway/admin/billing/")) return false;
    const rid = requestId(req);
    try {
      const actor = await authenticate(req);
      const url = new URL(req.url ?? path, `http://${req.headers.host ?? "localhost"}`);

      let match = path.match(/^\/api\/gateway\/admin\/billing\/accounts\/([^/]+)$/);
      if (match && req.method === "GET") {
        const tenantId = decodeURIComponent(match[1]);
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.accounts.read", action: "billing.account.read",
          resourceType: "billing_account", tenantId,
          run: async () => {
            const account = await billing.getAccount(tenantId);
            if (!account) throw new Error(`Billing account not found: ${tenantId}`);
            return account;
          },
        });
        json(res, 200, body, rid);
        return true;
      }

      if (match && req.method === "PUT") {
        const tenantId = decodeURIComponent(match[1]);
        const request = await readJson(req) as Record<string, unknown>;
        const creditLimitMicros = positiveIntegerString(
          request.credit_limit_micros ?? "0",
          "credit_limit_micros",
          true,
        );
        const currency = optionalString(request.currency) ?? "USD";
        if (currency !== "USD") throw new Error("Only USD billing accounts are currently supported");
        if (request.enabled !== undefined && typeof request.enabled !== "boolean") {
          throw new Error("enabled must be boolean");
        }
        const result = await mutation({
          req, actor, requestId: rid, permission: "billing.accounts.write",
          action: "billing.account.upsert", resourceType: "billing_account",
          resourceId: tenantId, tenantId, request, status: 200,
          run: () => billing.upsertAccount({
            tenantId,
            currency,
            creditLimitMicros,
            enabled: request.enabled as boolean | undefined,
          }),
        });
        json(res, result.status, result.body, rid,
          result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/billing\/accounts\/([^/]+)\/exposure$/);
      if (match && req.method === "GET") {
        const tenantId = decodeURIComponent(match[1]);
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.accounts.read",
          action: "billing.exposure.read", resourceType: "billing_account", tenantId,
          run: async () => {
            const account = await billing.getAccount(tenantId);
            if (!account) throw new Error(`Billing account not found: ${tenantId}`);
            const availableMicros = await billing.getAvailableMicros(tenantId);
            const exposure = await billing.pool.query(
              `SELECT
                 COALESCE((SELECT SUM(CASE WHEN direction='credit' THEN amount_micros ELSE -amount_micros END)
                   FROM gateway_ledger_entries WHERE book='customer' AND tenant_id=$1),0)::bigint AS ledger_balance_micros,
                 COALESCE((SELECT SUM(GREATEST(0,amount_micros-consumed_micros))
                   FROM gateway_reservations WHERE tenant_id=$1 AND state='active' AND expires_at > now()),0)::bigint AS reserved_micros`,
              [tenantId],
            );
            return {
              account,
              ledger_balance_micros: String(exposure.rows[0]?.ledger_balance_micros ?? "0"),
              reserved_micros: String(exposure.rows[0]?.reserved_micros ?? "0"),
              available_micros: availableMicros.toString(),
            };
          },
        });
        json(res, 200, body, rid);
        return true;
      }

      if (path === "/api/gateway/admin/billing/price-rules" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.pricing.read",
          action: "billing.price_rule.list", resourceType: "price_rule", tenantId,
          run: async () => {
            const rows = await billing.listPriceRules(tenantId);
            if (!tenantId || hasBillingPermission(actor, "billing.pricing.read")) return rows;
            return rows.filter((row) => row.tenantId === tenantId);
          },
        });
        json(res, 200, body, rid);
        return true;
      }

      if (path === "/api/gateway/admin/billing/price-rules" && req.method === "POST") {
        const request = await readJson(req) as Record<string, unknown>;
        const tenantId = optionalString(request.tenant_id);
        const effectiveFrom = optionalString(request.effective_from);
        if (!effectiveFrom || !Number.isFinite(new Date(effectiveFrom).getTime())) {
          throw new Error("effective_from must be an ISO timestamp");
        }
        const effectiveTo = optionalString(request.effective_to);
        if (effectiveTo && !Number.isFinite(new Date(effectiveTo).getTime())) {
          throw new Error("effective_to must be an ISO timestamp");
        }
        const normalized = {
          tenantId,
          providerType: optionalString(request.provider_type),
          model: optionalString(request.model),
          metric: parseMetric(request.metric),
          unitScale: positiveIntegerString(request.unit_scale, "unit_scale"),
          upstreamPriceMicros: request.upstream_price_micros == null
            ? undefined
            : positiveIntegerString(request.upstream_price_micros, "upstream_price_micros", true),
          customerPriceMicros: request.customer_price_micros == null
            ? undefined
            : positiveIntegerString(request.customer_price_micros, "customer_price_micros", true),
          currency: optionalString(request.currency) ?? "USD",
          effectiveFrom,
          effectiveTo,
        };
        if (normalized.currency !== "USD") throw new Error("Only USD PriceRules are currently supported");
        if (normalized.upstreamPriceMicros === undefined && normalized.customerPriceMicros === undefined) {
          throw new Error("At least one of upstream_price_micros or customer_price_micros is required");
        }
        const result = await mutation({
          req, actor, requestId: rid, permission: "billing.pricing.write",
          action: "billing.price_rule.create", resourceType: "price_rule", tenantId,
          request: normalized, status: 201,
          run: () => billing.createPriceRule(normalized),
          resultResourceId: (value: any) => value?.id,
        });
        json(res, result.status, result.body, rid,
          result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      if (path === "/api/gateway/admin/billing/credits" && req.method === "POST") {
        const request = await readJson(req) as Record<string, unknown>;
        const tenantId = optionalString(request.tenant_id);
        if (!tenantId) throw new Error("tenant_id is required");
        const amountMicros = positiveIntegerString(request.amount_micros, "amount_micros");
        const reason = optionalString(request.reason);
        const creditFingerprint = stableRequestHash({ tenantId, amountMicros, reason });
        const result = await mutation({
          req, actor, requestId: rid, permission: "billing.credits.write",
          action: "billing.credit.grant", resourceType: "ledger_entry", tenantId,
          request: { tenantId, amountMicros, reason }, status: 201,
          run: (key) => billing.grantCredit({
            tenantId,
            amountMicros,
            idempotencyKey: `control:${actor.id}:billing.credit.grant:${tenantId}:${key}:${creditFingerprint}`,
            metadata: { reason, actor_id: actor.id, request_id: rid },
          }),
          resultResourceId: (value: any) => value?.id,
        });
        json(res, result.status, result.body, rid,
          result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {});
        return true;
      }

      if (path === "/api/gateway/admin/billing/usage" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        const sessionId = optionalString(url.searchParams.get("session_id"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.usage.read",
          action: "billing.usage.list", resourceType: "usage_event", tenantId,
          run: () => billing.listUsage({ tenantId, sessionId, limit }),
        });
        json(res, 200, body, rid);
        return true;
      }

      if (path === "/api/gateway/admin/billing/ledger" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        const sessionId = optionalString(url.searchParams.get("session_id"));
        const book = parseBook(url.searchParams.get("book"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.ledger.read",
          action: "billing.ledger.list", resourceType: "ledger_entry", tenantId,
          run: () => billing.listLedger({ tenantId, sessionId, book, limit }),
        });
        json(res, 200, body, rid);
        return true;
      }

      if (path === "/api/gateway/admin/billing/reservations" && req.method === "GET") {
        const tenantId = optionalString(url.searchParams.get("tenant_id"));
        const sessionId = optionalString(url.searchParams.get("session_id"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const body = await auditedRead({
          actor, requestId: rid, permission: "billing.reservations.read",
          action: "billing.reservation.list", resourceType: "reservation", tenantId,
          run: async () => {
            const values: unknown[] = [];
            const clauses: string[] = [];
            if (tenantId) { values.push(tenantId); clauses.push(`tenant_id=$${values.length}`); }
            if (sessionId) { values.push(sessionId); clauses.push(`session_id=$${values.length}`); }
            values.push(limit);
            const rows = await billing.pool.query(
              `SELECT id,tenant_id,project_id,session_id,request_ref,amount_micros,consumed_micros,currency,state,expires_at,created_at,updated_at
               FROM gateway_reservations
               ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
               ORDER BY created_at DESC LIMIT $${values.length}`,
              values,
            );
            return rows.rows.map((row) => ({
              id: String(row.id),
              tenantId: String(row.tenant_id),
              projectId: row.project_id ? String(row.project_id) : undefined,
              sessionId: row.session_id ? String(row.session_id) : undefined,
              requestRef: String(row.request_ref),
              amountMicros: String(row.amount_micros),
              consumedMicros: String(row.consumed_micros),
              currency: String(row.currency),
              state: String(row.state),
              expiresAt: new Date(row.expires_at).toISOString(),
              createdAt: new Date(row.created_at).toISOString(),
              updatedAt: new Date(row.updated_at).toISOString(),
            }));
          },
        });
        json(res, 200, body, rid);
        return true;
      }

      json(res, 404, {
        error: { type: "not_found", message: "Billing Control Plane route not found" },
      }, rid);
      return true;
    } catch (error) {
      json(res, errorStatus(error), {
        error: {
          type: "gateway_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }, rid);
      return true;
    }
  };
}
