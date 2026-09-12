import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { hashVirtualKey, stableRequestHash } from "@agent-gateway/core";
import {
  bootstrapActor,
  ControlPlaneAuthorizationError,
  hashControlPlaneToken,
  requirePermission,
  secureTokenEqual,
  tokenPrefix as controlTokenPrefix,
  type ControlPlaneActor,
  type ControlPlanePermission,
  type ControlPlaneRole,
  type PostgresControlPlaneSecurity,
  type RoleScopeType,
} from "@agent-gateway/control-plane-auth";
import { credentialContext, type CredentialKeyring } from "@agent-gateway/credential-crypto";
import type { PostgresGatewayStore } from "@agent-gateway/storage-postgres";

export interface ControlPlaneDependencies {
  store: PostgresGatewayStore;
  security: PostgresControlPlaneSecurity;
  credentialKeyring: CredentialKeyring;
  moduleCatalog: Record<string, string>;
  reloadGateway: () => Promise<void>;
  bootstrapToken?: string;
  idempotencyPendingTtlSeconds: number;
  idempotencyCompletedTtlSeconds: number;
}

interface MutationResult<T> {
  status: number;
  body: T;
  replay: boolean;
}

function prefixedId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function createVirtualKeySecret() {
  return `ag_${randomBytes(32).toString("base64url")}`;
}

function createControlPlaneSecret() {
  return `agcp_${randomBytes(32).toString("base64url")}`;
}

function readBearer(req: http.IncomingMessage) {
  return req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function requestId(req: http.IncomingMessage) {
  const header = req.headers["x-request-id"];
  return typeof header === "string" && header.trim()
    ? header.trim().slice(0, 256)
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
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

function errorStatus(error: unknown) {
  if (error instanceof ControlPlaneAuthorizationError) return 403;
  const message = error instanceof Error ? error.message : String(error);
  if (/Invalid control plane token/.test(message)) return 401;
  if (/Control plane idempotency request is still in progress|Control plane idempotency key was already used/.test(message)) return 409;
  if (/Provider not found|Credential not found|Channel not found|Control principal not found|Role binding not found/.test(message)) return 404;
  if (/Unknown provider type|must be|required|Sensitive field|Invalid role|Invalid scope|Idempotency-Key/.test(message)) return 400;
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23503" || code === "23514") return 409;
  return 500;
}

function recordObject(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertNonSecretConfig(value: unknown, path = "config") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNonSecretConfig(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if ([
      "apikey", "token", "accesstoken", "refreshtoken", "secret",
      "clientsecret", "password", "authorization", "credential",
    ].some((needle) => normalized.includes(needle))) {
      throw new Error(`Sensitive field ${path}.${key} must be stored as a Credential`);
    }
    assertNonSecretConfig(item, `${path}.${key}`);
  }
}

function parseRole(value: unknown): ControlPlaneRole {
  if (value === "owner" || value === "admin" || value === "operator" || value === "viewer") return value;
  throw new Error("Invalid role");
}

function parseScope(value: unknown): RoleScopeType {
  if (value === "global" || value === "tenant") return value;
  throw new Error("Invalid scope_type");
}

function idempotencyContext(actorId: string, scope: string, key: string) {
  return `agent-gateway:control-idempotency:${actorId}:scope:${scope}:key:${key}`;
}

export function createControlPlaneHandler(deps: ControlPlaneDependencies) {
  const {
    store,
    security,
    credentialKeyring,
    moduleCatalog,
    reloadGateway,
    bootstrapToken,
    idempotencyPendingTtlSeconds,
    idempotencyCompletedTtlSeconds,
  } = deps;

  security.attachTransactionalPool(store.pool);

  async function authenticate(req: http.IncomingMessage): Promise<ControlPlaneActor> {
    const token = readBearer(req);
    if (!token) throw new Error("Invalid control plane token");
    if (bootstrapToken && secureTokenEqual(token, bootstrapToken)) return bootstrapActor();
    const actor = await security.authenticateToken(token);
    if (!actor) throw new Error("Invalid control plane token");
    return actor;
  }

  async function appendAudit(input: {
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
    permission: ControlPlanePermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
  }) {
    try {
      requirePermission(input.actor, input.permission, input.tenantId);
    } catch (error) {
      await appendAudit({
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

  async function beginIdempotency(input: {
    req: http.IncomingMessage;
    actor: ControlPlaneActor;
    scope: string;
    request: unknown;
  }) {
    const raw = input.req.headers["idempotency-key"];
    const key = typeof raw === "string" ? raw.trim() : undefined;
    if (!key) return undefined;
    if (key.length > 256) throw new Error("Idempotency-Key must be at most 256 characters");

    const requestHash = stableRequestHash(input.request);
    const context = idempotencyContext(input.actor.id, input.scope, key);
    const claim = await security.claimControlIdempotency({
      actorId: input.actor.id,
      scope: input.scope,
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
      const decoded = credentialKeyring.decrypt<{ status: number; body: unknown }>(
        claim.responseEnvelope,
        context,
      );
      return {
        state: "replay" as const,
        status: Number(decoded.status ?? claim.responseStatus),
        body: decoded.body,
      };
    }
    return {
      state: "claimed" as const,
      key,
      requestHash,
      async complete(status: number, body: unknown) {
        const encrypted = credentialKeyring.encrypt({ status, body }, context);
        await security.completeControlIdempotency({
          actorId: input.actor.id,
          scope: input.scope,
          key,
          requestHash,
          responseStatus: status,
          responseEnvelope: encrypted.envelope,
          expiresAt: new Date(Date.now() + idempotencyCompletedTtlSeconds * 1000).toISOString(),
        });
      },
      async release() {
        await security.releaseControlIdempotency({
          actorId: input.actor.id,
          scope: input.scope,
          key,
          requestHash,
        });
      },
    };
  }

  async function mutate<T>(input: {
    req: http.IncomingMessage;
    actor: ControlPlaneActor;
    requestId: string;
    permission: ControlPlanePermission;
    action: string;
    resourceType: string;
    resourceId?: string;
    tenantId?: string;
    metadata?: Record<string, unknown>;
    request: unknown;
    status: number;
    reloadRuntime?: boolean;
    run: () => Promise<T>;
    resultResourceId?: (result: T) => string | undefined;
  }): Promise<MutationResult<T>> {
    await authorize(input);
    let idem: Awaited<ReturnType<typeof beginIdempotency>>;

    try {
      idem = await beginIdempotency({
        req: input.req,
        actor: input.actor,
        scope: input.action,
        request: input.request,
      });
      if (idem?.state === "replay") {
        const replayBody = idem.body as T;
        await appendAudit({
          actor: input.actor,
          requestId: input.requestId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(replayBody) ?? input.resourceId,
          tenantId: input.tenantId,
          outcome: "success",
          metadata: { ...input.metadata, idempotent_replay: true },
        });
        return { status: idem.status, body: replayBody, replay: true };
      }

      const result = await security.withTransaction(async () => {
        const body = await input.run();
        await appendAudit({
          actor: input.actor,
          requestId: input.requestId,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: input.resultResourceId?.(body) ?? input.resourceId,
          tenantId: input.tenantId,
          outcome: "success",
          metadata: input.metadata,
        });
        if (idem?.state === "claimed") await idem.complete(input.status, body);
        return body;
      });

      if (input.reloadRuntime) {
        try {
          await reloadGateway();
        } catch (error) {
          await appendAudit({
            actor: input.actor,
            requestId: input.requestId,
            action: `${input.action}.runtime_reload`,
            resourceType: input.resourceType,
            resourceId: input.resultResourceId?.(result) ?? input.resourceId,
            tenantId: input.tenantId,
            outcome: "error",
            metadata: { error: error instanceof Error ? error.message : String(error) },
          }).catch(() => undefined);
          console.error("control-plane runtime reload failed", error);
        }
      }

      return { status: input.status, body: result, replay: false };
    } catch (error) {
      if (idem?.state === "claimed") await idem.release().catch(() => undefined);
      await appendAudit({
        actor: input.actor,
        requestId: input.requestId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        tenantId: input.tenantId,
        outcome: "error",
        metadata: { ...input.metadata, error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
      throw error;
    }
  }

  async function read(input: {
    actor: ControlPlaneActor;
    requestId: string;
    permission: ControlPlanePermission;
    action: string;
    resourceType: string;
    tenantId?: string;
    auditSuccess?: boolean;
    run: () => Promise<unknown>;
  }) {
    await authorize(input);
    const result = await input.run();
    if (input.auditSuccess) {
      await appendAudit({
        actor: input.actor,
        requestId: input.requestId,
        action: input.action,
        resourceType: input.resourceType,
        tenantId: input.tenantId,
        outcome: "success",
      });
    }
    return result;
  }

  function mutationHeaders<T>(rid: string, result: MutationResult<T>) {
    return {
      "x-request-id": rid,
      ...(result.replay ? { "x-agent-gateway-idempotent-replay": "true" } : {}),
    };
  }

  return async function handleControlPlane(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ) {
    if (!path.startsWith("/api/gateway/admin/")) return false;
    const rid = requestId(req);
    const responseHeaders = { "x-request-id": rid };

    try {
      const actor = await authenticate(req);

      if (req.method === "POST" && path === "/api/gateway/admin/tenants") {
        const body = await readJson(req) as { name?: string };
        if (!body.name?.trim()) throw new Error("Tenant name is required");
        const result = await mutate({
          req, actor, requestId: rid, permission: "tenants.write", action: "tenant.create",
          resourceType: "tenant", request: body, status: 201,
          run: () => store.createTenant({ id: prefixedId("tenant"), name: body.name!.trim() }),
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/projects") {
        const body = await readJson(req) as { tenant_id?: string; name?: string };
        if (!body.tenant_id?.trim() || !body.name?.trim()) {
          throw new Error("tenant_id and project name are required");
        }
        const tenantId = body.tenant_id.trim();
        const result = await mutate({
          req, actor, requestId: rid, permission: "projects.write", action: "project.create",
          resourceType: "project", tenantId, request: body, status: 201,
          run: () => store.createProject({ id: prefixedId("project"), tenantId, name: body.name!.trim() }),
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/virtual-keys") {
        const body = await readJson(req) as {
          tenant_id?: string;
          project_id?: string;
          name?: string;
          expires_at?: string;
        };
        if (!body.tenant_id?.trim() || !body.name?.trim()) {
          throw new Error("tenant_id and key name are required");
        }
        if (body.expires_at && !Number.isFinite(new Date(body.expires_at).getTime())) {
          throw new Error("expires_at must be a valid date-time");
        }
        const tenantId = body.tenant_id.trim();
        const result = await mutate({
          req, actor, requestId: rid, permission: "keys.write", action: "virtual_key.create",
          resourceType: "virtual_key", tenantId, request: body, status: 201,
          run: async () => {
            const secret = createVirtualKeySecret();
            const record = await store.createVirtualKey({
              id: prefixedId("vk"),
              tenantId,
              projectId: body.project_id?.trim() || undefined,
              name: body.name!.trim(),
              keyHash: hashVirtualKey(secret),
              keyPrefix: secret.slice(0, 10),
              expiresAt: body.expires_at,
            });
            return { ...record, key: secret };
          },
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/providers") {
        const result = await read({
          actor, requestId: rid, permission: "providers.read", action: "provider.list",
          resourceType: "provider", run: () => store.listProviders(),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/providers") {
        const body = await readJson(req) as {
          type?: string;
          display_name?: string;
          enabled?: boolean;
          config?: unknown;
        };
        const type = body.type?.trim();
        if (!type || !moduleCatalog[type]) throw new Error(`Unknown provider type: ${type ?? ""}`);
        const config = body.config === undefined ? {} : recordObject(body.config, "config");
        assertNonSecretConfig(config);
        const result = await mutate({
          req, actor, requestId: rid, permission: "providers.write", action: "provider.create",
          resourceType: "provider", request: body, status: 201, reloadRuntime: true,
          run: () => store.createProvider({
            id: prefixedId("agprov"),
            type,
            displayName: body.display_name?.trim() || type,
            enabled: body.enabled ?? true,
            config,
          }),
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      let match = path.match(/^\/api\/gateway\/admin\/providers\/([^/]+)$/);
      if (req.method === "PATCH" && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readJson(req) as { display_name?: string; enabled?: boolean; config?: unknown };
        const config = body.config === undefined ? undefined : recordObject(body.config, "config");
        if (config) assertNonSecretConfig(config);
        const result = await mutate({
          req, actor, requestId: rid, permission: "providers.write", action: "provider.update",
          resourceType: "provider", resourceId: id, request: { id, body }, status: 200,
          reloadRuntime: true,
          run: () => store.updateProvider(id, {
            displayName: body.display_name?.trim() || undefined,
            enabled: body.enabled,
            config,
          }),
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/credentials") {
        const result = await read({
          actor, requestId: rid, permission: "credentials.read", action: "credential.list",
          resourceType: "credential", auditSuccess: true, run: () => store.listCredentials(),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/credentials") {
        const body = await readJson(req) as {
          provider_id?: string;
          name?: string;
          kind?: string;
          payload?: unknown;
        };
        if (!body.provider_id?.trim() || !body.name?.trim()) {
          throw new Error("provider_id and credential name are required");
        }
        const payload = recordObject(body.payload, "payload");
        const providerId = body.provider_id.trim();
        const result = await mutate({
          req, actor, requestId: rid, permission: "credentials.write", action: "credential.create",
          resourceType: "credential", request: body, status: 201,
          metadata: { provider_id: providerId, kind: body.kind?.trim() || "generic" },
          run: async () => {
            const id = prefixedId("agcred");
            const encrypted = credentialKeyring.encrypt(payload, credentialContext(id, providerId));
            return store.createCredential({
              id,
              providerId,
              name: body.name!.trim(),
              kind: body.kind?.trim() || "generic",
              encryptedPayload: encrypted.envelope,
              encryptionKeyId: encrypted.keyId,
              algorithm: encrypted.algorithm,
            });
          },
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/credentials\/([^/]+)$/);
      if (req.method === "PATCH" && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readJson(req) as { payload?: unknown };
        const payload = recordObject(body.payload, "payload");
        const result = await mutate({
          req, actor, requestId: rid, permission: "credentials.write",
          action: "credential.secret.replace", resourceType: "credential", resourceId: id,
          request: { id, payload }, status: 200, reloadRuntime: true,
          run: async () => {
            const existing = await store.getEncryptedCredential(id);
            if (!existing) throw new Error(`Credential not found: ${id}`);
            const encrypted = credentialKeyring.encrypt(payload, credentialContext(id, existing.providerId));
            return store.updateCredentialEnvelope(id, {
              encryptedPayload: encrypted.envelope,
              encryptionKeyId: encrypted.keyId,
              algorithm: encrypted.algorithm,
            });
          },
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/credentials\/([^/]+)\/rewrap$/);
      if (req.method === "POST" && match) {
        const id = decodeURIComponent(match[1]);
        const result = await mutate({
          req, actor, requestId: rid, permission: "credentials.rewrap", action: "credential.rewrap",
          resourceType: "credential", resourceId: id, request: { id }, status: 200,
          reloadRuntime: true,
          run: async () => {
            const existing = await store.getEncryptedCredential(id);
            if (!existing) throw new Error(`Credential not found: ${id}`);
            const encrypted = credentialKeyring.rewrap(
              existing.encryptedPayload,
              credentialContext(id, existing.providerId),
            );
            return store.updateCredentialEnvelope(id, {
              encryptedPayload: encrypted.envelope,
              encryptionKeyId: encrypted.keyId,
              algorithm: encrypted.algorithm,
            });
          },
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/channels") {
        const result = await read({
          actor, requestId: rid, permission: "channels.read", action: "channel.list",
          resourceType: "channel", run: () => store.listChannels(),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/channels") {
        const body = await readJson(req) as {
          provider_id?: string;
          credential_id?: string;
          name?: string;
          enabled?: boolean;
          priority?: number;
          weight?: number;
          config?: unknown;
        };
        if (!body.provider_id?.trim() || !body.name?.trim()) {
          throw new Error("provider_id and channel name are required");
        }
        const config = body.config === undefined ? {} : recordObject(body.config, "config");
        assertNonSecretConfig(config);
        const result = await mutate({
          req, actor, requestId: rid, permission: "channels.write", action: "channel.create",
          resourceType: "channel", request: body, status: 201, reloadRuntime: true,
          run: () => store.createChannel({
            id: prefixedId("agch"),
            providerId: body.provider_id!.trim(),
            credentialId: body.credential_id?.trim() || undefined,
            name: body.name!.trim(),
            enabled: body.enabled ?? true,
            priority: body.priority,
            weight: body.weight,
            config,
          }),
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/channels\/([^/]+)$/);
      if (req.method === "PATCH" && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readJson(req) as {
          credential_id?: string | null;
          name?: string;
          enabled?: boolean;
          priority?: number;
          weight?: number;
          config?: unknown;
        };
        const config = body.config === undefined ? undefined : recordObject(body.config, "config");
        if (config) assertNonSecretConfig(config);
        const patch: {
          credentialId?: string | null;
          name?: string;
          enabled?: boolean;
          priority?: number;
          weight?: number;
          config?: Record<string, unknown>;
        } = {
          name: body.name?.trim() || undefined,
          enabled: body.enabled,
          priority: body.priority,
          weight: body.weight,
          config,
        };
        if (Object.prototype.hasOwnProperty.call(body, "credential_id")) {
          patch.credentialId = body.credential_id?.trim() || null;
        }
        const result = await mutate({
          req, actor, requestId: rid, permission: "channels.write", action: "channel.update",
          resourceType: "channel", resourceId: id, request: { id, body }, status: 200,
          reloadRuntime: true, run: () => store.updateChannel(id, patch),
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/principals") {
        const result = await read({
          actor, requestId: rid, permission: "rbac.read", action: "principal.list",
          resourceType: "control_principal", auditSuccess: true, run: () => security.listPrincipals(),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/principals") {
        const body = await readJson(req) as { name?: string; expires_at?: string };
        if (!body.name?.trim()) throw new Error("Principal name is required");
        if (body.expires_at && !Number.isFinite(new Date(body.expires_at).getTime())) {
          throw new Error("expires_at must be a valid date-time");
        }
        const result = await mutate({
          req, actor, requestId: rid, permission: "rbac.manage", action: "principal.create",
          resourceType: "control_principal", request: body, status: 201,
          run: async () => {
            const secret = createControlPlaneSecret();
            const id = prefixedId("agcp");
            const principal = await security.createPrincipal({
              id,
              name: body.name!.trim(),
              tokenHash: hashControlPlaneToken(secret),
              tokenPrefix: controlTokenPrefix(secret),
              expiresAt: body.expires_at,
            });
            return { ...principal, token: secret };
          },
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/principals\/([^/]+)$/);
      if (req.method === "PATCH" && match) {
        const id = decodeURIComponent(match[1]);
        const body = await readJson(req) as { enabled?: boolean };
        if (typeof body.enabled !== "boolean") throw new Error("enabled is required");
        const result = await mutate({
          req, actor, requestId: rid, permission: "rbac.manage", action: "principal.update",
          resourceType: "control_principal", resourceId: id, request: { id, body }, status: 200,
          run: () => security.setPrincipalEnabled(id, body.enabled!),
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/role-bindings") {
        const result = await read({
          actor, requestId: rid, permission: "rbac.read", action: "role_binding.list",
          resourceType: "role_binding", auditSuccess: true, run: () => security.listRoleBindings(),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      if (req.method === "POST" && path === "/api/gateway/admin/role-bindings") {
        const body = await readJson(req) as {
          principal_id?: string;
          role?: unknown;
          scope_type?: unknown;
          scope_id?: string;
        };
        if (!body.principal_id?.trim()) throw new Error("principal_id is required");
        const role = parseRole(body.role);
        const scopeType = parseScope(body.scope_type);
        const scopeId = body.scope_id?.trim() || undefined;
        if (scopeType === "tenant" && !scopeId) throw new Error("scope_id is required for tenant scope");
        if (scopeType === "global" && scopeId) throw new Error("scope_id must be omitted for global scope");
        const result = await mutate({
          req, actor, requestId: rid, permission: "rbac.manage", action: "role_binding.create",
          resourceType: "role_binding", request: body, status: 201,
          metadata: {
            principal_id: body.principal_id.trim(),
            role,
            scope_type: scopeType,
            scope_id: scopeId,
          },
          run: () => security.createRoleBinding({
            id: prefixedId("agrb"),
            principalId: body.principal_id!.trim(),
            role,
            scopeType,
            scopeId,
          }),
          resultResourceId: (value: any) => value.id,
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      match = path.match(/^\/api\/gateway\/admin\/role-bindings\/([^/]+)$/);
      if (req.method === "DELETE" && match) {
        const id = decodeURIComponent(match[1]);
        const result = await mutate({
          req, actor, requestId: rid, permission: "rbac.manage", action: "role_binding.delete",
          resourceType: "role_binding", resourceId: id, request: { id }, status: 200,
          run: () => security.deleteRoleBinding(id),
        });
        json(res, result.status, result.body, mutationHeaders(rid, result));
        return true;
      }

      if (req.method === "GET" && path === "/api/gateway/admin/audit") {
        const url = new URL(req.url ?? path, `http://${req.headers.host ?? "localhost"}`);
        const tenantId = url.searchParams.get("tenant_id")?.trim() || undefined;
        const outcome = url.searchParams.get("outcome") as "success" | "denied" | "error" | null;
        if (outcome && !["success", "denied", "error"].includes(outcome)) {
          throw new Error("Invalid audit outcome");
        }
        const result = await read({
          actor,
          requestId: rid,
          permission: "audit.read",
          action: "audit.list",
          resourceType: "audit_event",
          tenantId,
          auditSuccess: true,
          run: () => security.listAudit({
            limit: Number(url.searchParams.get("limit") ?? 100),
            actorId: url.searchParams.get("actor_id")?.trim() || undefined,
            resourceType: url.searchParams.get("resource_type")?.trim() || undefined,
            resourceId: url.searchParams.get("resource_id")?.trim() || undefined,
            tenantId,
            outcome: outcome || undefined,
          }),
        });
        json(res, 200, result, responseHeaders);
        return true;
      }

      json(
        res,
        404,
        { error: { type: "not_found", message: "Control plane route not found" } },
        responseHeaders,
      );
      return true;
    } catch (error) {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return true;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(
        res,
        errorStatus(error),
        { error: { type: "gateway_error", message } },
        responseHeaders,
      );
      return true;
    }
  };
}
