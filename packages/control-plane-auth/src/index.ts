import { createHash, timingSafeEqual } from "node:crypto";
import { Pool, type PoolConfig } from "pg";

export type ControlPlanePermission =
  | "tenants.write"
  | "projects.write"
  | "keys.write"
  | "providers.read"
  | "providers.write"
  | "credentials.read"
  | "credentials.write"
  | "credentials.rewrap"
  | "channels.read"
  | "channels.write"
  | "rbac.read"
  | "rbac.manage"
  | "audit.read";

export type ControlPlaneRole = "owner" | "admin" | "operator" | "viewer";
export type RoleScopeType = "global" | "tenant";

const ALL_PERMISSIONS: ControlPlanePermission[] = [
  "tenants.write",
  "projects.write",
  "keys.write",
  "providers.read",
  "providers.write",
  "credentials.read",
  "credentials.write",
  "credentials.rewrap",
  "channels.read",
  "channels.write",
  "rbac.read",
  "rbac.manage",
  "audit.read",
];

const ROLE_PERMISSIONS: Record<ControlPlaneRole, ReadonlySet<ControlPlanePermission>> = {
  owner: new Set(ALL_PERMISSIONS),
  admin: new Set(ALL_PERMISSIONS.filter((permission) => permission !== "rbac.manage")),
  operator: new Set([
    "tenants.write",
    "projects.write",
    "keys.write",
    "providers.read",
    "providers.write",
    "credentials.read",
    "credentials.write",
    "credentials.rewrap",
    "channels.read",
    "channels.write",
  ]),
  viewer: new Set([
    "providers.read",
    "credentials.read",
    "channels.read",
    "rbac.read",
    "audit.read",
  ]),
};

export interface ControlPlaneActor {
  id: string;
  name: string;
  kind: "bootstrap" | "principal";
  bindings: RoleBinding[];
}

export interface PrincipalRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  enabled: boolean;
  expiresAt?: string;
  createdAt: string;
}

export interface RoleBinding {
  id: string;
  principalId: string;
  role: ControlPlaneRole;
  scopeType: RoleScopeType;
  scopeId?: string;
  createdAt: string;
}

export interface AuditEventInput {
  id: string;
  actor: ControlPlaneActor;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  tenantId?: string;
  outcome: "success" | "denied" | "error";
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  actorType: ControlPlaneActor["kind"];
  actorId: string;
  actorName: string;
  requestId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  tenantId?: string;
  outcome: "success" | "denied" | "error";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class ControlPlaneAuthorizationError extends Error {
  constructor(
    message: string,
    readonly permission: ControlPlanePermission,
    readonly tenantId?: string,
  ) {
    super(message);
    this.name = "ControlPlaneAuthorizationError";
  }
}

export function hashControlPlaneToken(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function tokenPrefix(secret: string) {
  return secret.slice(0, 12);
}

export function bootstrapActor(name = "bootstrap-admin"): ControlPlaneActor {
  return {
    id: "bootstrap",
    name,
    kind: "bootstrap",
    bindings: [{
      id: "bootstrap-owner",
      principalId: "bootstrap",
      role: "owner",
      scopeType: "global",
      createdAt: new Date(0).toISOString(),
    }],
  };
}

export function hasPermission(
  actor: ControlPlaneActor,
  permission: ControlPlanePermission,
  tenantId?: string,
) {
  return actor.bindings.some((binding) => {
    if (!ROLE_PERMISSIONS[binding.role].has(permission)) return false;
    if (binding.scopeType === "global") return true;
    return Boolean(tenantId && binding.scopeType === "tenant" && binding.scopeId === tenantId);
  });
}

export function requirePermission(
  actor: ControlPlaneActor,
  permission: ControlPlanePermission,
  tenantId?: string,
) {
  if (!hasPermission(actor, permission, tenantId)) {
    throw new ControlPlaneAuthorizationError(
      `Control plane permission denied: ${permission}`,
      permission,
      tenantId,
    );
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_control_principals (
  id text PRIMARY KEY,
  name text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_control_principals_enabled_idx
  ON gateway_control_principals(enabled)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS gateway_role_bindings (
  id text PRIMARY KEY,
  principal_id text NOT NULL REFERENCES gateway_control_principals(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'tenant')),
  scope_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL)
    OR
    (scope_type = 'tenant' AND scope_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_role_bindings_unique_idx
  ON gateway_role_bindings(principal_id, role, scope_type, COALESCE(scope_id, ''));

CREATE TABLE IF NOT EXISTS gateway_audit_events (
  id text PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('bootstrap', 'principal')),
  actor_id text NOT NULL,
  actor_name text NOT NULL,
  request_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  tenant_id text,
  outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_audit_events_created_idx
  ON gateway_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_audit_events_actor_idx
  ON gateway_audit_events(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_audit_events_resource_idx
  ON gateway_audit_events(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS gateway_audit_events_tenant_idx
  ON gateway_audit_events(tenant_id, created_at DESC)
  WHERE tenant_id IS NOT NULL;

CREATE OR REPLACE FUNCTION gateway_reject_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_audit_events_no_update ON gateway_audit_events;
CREATE TRIGGER gateway_audit_events_no_update
  BEFORE UPDATE ON gateway_audit_events
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_audit_mutation();

DROP TRIGGER IF EXISTS gateway_audit_events_no_delete ON gateway_audit_events;
CREATE TRIGGER gateway_audit_events_no_delete
  BEFORE DELETE ON gateway_audit_events
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_audit_mutation();
`;

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function principalFromRow(row: Record<string, any>): PrincipalRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    tokenPrefix: String(row.token_prefix),
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
    createdAt: iso(row.created_at),
  };
}

function bindingFromRow(row: Record<string, any>): RoleBinding {
  return {
    id: String(row.id),
    principalId: String(row.principal_id),
    role: row.role,
    scopeType: row.scope_type,
    scopeId: row.scope_id ? String(row.scope_id) : undefined,
    createdAt: iso(row.created_at),
  };
}

function auditFromRow(row: Record<string, any>): AuditEventRecord {
  return {
    id: String(row.id),
    actorType: row.actor_type,
    actorId: String(row.actor_id),
    actorName: String(row.actor_name),
    requestId: String(row.request_id),
    action: String(row.action),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ? String(row.resource_id) : undefined,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    outcome: row.outcome,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

export class PostgresControlPlaneSecurity {
  readonly pool: Pool;

  constructor(config: string | PoolConfig) {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async close() {
    await this.pool.end();
  }

  async migrate() {
    await this.pool.query(SCHEMA_SQL);
  }

  async createPrincipal(input: {
    id: string;
    name: string;
    tokenHash: string;
    tokenPrefix: string;
    expiresAt?: string;
  }) {
    const result = await this.pool.query(
      `INSERT INTO gateway_control_principals(id, name, token_hash, token_prefix, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [input.id, input.name, input.tokenHash, input.tokenPrefix, input.expiresAt ?? null],
    );
    return principalFromRow(result.rows[0]);
  }

  async listPrincipals() {
    const result = await this.pool.query(
      `SELECT id, name, token_prefix, enabled, expires_at, created_at
       FROM gateway_control_principals
       ORDER BY created_at DESC`,
    );
    return result.rows.map(principalFromRow);
  }

  async setPrincipalEnabled(id: string, enabled: boolean) {
    const result = await this.pool.query(
      `UPDATE gateway_control_principals
       SET enabled = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, name, token_prefix, enabled, expires_at, created_at`,
      [id, enabled],
    );
    if (!result.rows[0]) throw new Error(`Control principal not found: ${id}`);
    return principalFromRow(result.rows[0]);
  }

  async authenticateTokenHash(tokenHash: string): Promise<ControlPlaneActor | undefined> {
    const principal = await this.pool.query(
      `SELECT id, name, token_hash, enabled, expires_at
       FROM gateway_control_principals
       WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = principal.rows[0];
    if (!row || !row.enabled) return undefined;
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return undefined;

    const bindings = await this.pool.query(
      `SELECT * FROM gateway_role_bindings
       WHERE principal_id = $1
       ORDER BY created_at ASC`,
      [row.id],
    );

    return {
      id: String(row.id),
      name: String(row.name),
      kind: "principal",
      bindings: bindings.rows.map(bindingFromRow),
    };
  }

  async authenticateToken(secret: string) {
    return this.authenticateTokenHash(hashControlPlaneToken(secret));
  }

  async createRoleBinding(input: {
    id: string;
    principalId: string;
    role: ControlPlaneRole;
    scopeType: RoleScopeType;
    scopeId?: string;
  }) {
    const result = await this.pool.query(
      `INSERT INTO gateway_role_bindings(id, principal_id, role, scope_type, scope_id)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [input.id, input.principalId, input.role, input.scopeType, input.scopeId ?? null],
    );
    return bindingFromRow(result.rows[0]);
  }

  async listRoleBindings(principalId?: string) {
    const result = principalId
      ? await this.pool.query(
        `SELECT * FROM gateway_role_bindings WHERE principal_id = $1 ORDER BY created_at DESC`,
        [principalId],
      )
      : await this.pool.query(`SELECT * FROM gateway_role_bindings ORDER BY created_at DESC`);
    return result.rows.map(bindingFromRow);
  }

  async deleteRoleBinding(id: string) {
    const result = await this.pool.query(
      `DELETE FROM gateway_role_bindings WHERE id = $1 RETURNING *`,
      [id],
    );
    if (!result.rows[0]) throw new Error(`Role binding not found: ${id}`);
    return bindingFromRow(result.rows[0]);
  }

  async appendAudit(input: AuditEventInput) {
    const result = await this.pool.query(
      `INSERT INTO gateway_audit_events(
         id, actor_type, actor_id, actor_name, request_id,
         action, resource_type, resource_id, tenant_id, outcome, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       RETURNING *`,
      [
        input.id,
        input.actor.kind,
        input.actor.id,
        input.actor.name,
        input.requestId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.tenantId ?? null,
        input.outcome,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return auditFromRow(result.rows[0]);
  }

  async listAudit(input: {
    limit?: number;
    actorId?: string;
    resourceType?: string;
    resourceId?: string;
    tenantId?: string;
    outcome?: "success" | "denied" | "error";
  } = {}) {
    const limit = Math.max(1, Math.min(500, input.limit ?? 100));
    const clauses: string[] = [];
    const values: unknown[] = [];
    const push = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace("?", `$${values.length}`));
    };
    if (input.actorId) push("actor_id = ?", input.actorId);
    if (input.resourceType) push("resource_type = ?", input.resourceType);
    if (input.resourceId) push("resource_id = ?", input.resourceId);
    if (input.tenantId) push("tenant_id = ?", input.tenantId);
    if (input.outcome) push("outcome = ?", input.outcome);
    values.push(limit);
    const result = await this.pool.query(
      `SELECT * FROM gateway_audit_events
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(auditFromRow);
  }
}

export function secureTokenEqual(actual: string | undefined, expected: string) {
  if (!actual) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
