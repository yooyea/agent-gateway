import { Pool, type PoolConfig, type PoolClient } from "pg";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyStore,
  SessionRecord,
  SessionStore,
  VirtualKeyIdentity,
  VirtualKeyLookupStore,
} from "@agent-gateway/core";
import { hashVirtualKey } from "@agent-gateway/core";

export interface TenantRecord {
  id: string;
  name: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface ProjectRecord {
  id: string;
  tenantId: string;
  name: string;
  status: "active" | "disabled";
  createdAt: string;
}

export interface StoredVirtualKeyRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAt?: string;
  createdAt: string;
}

export interface CreateVirtualKeyInput {
  id: string;
  tenantId: string;
  projectId?: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  expiresAt?: string;
}

export interface ProviderRecord {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialRecord {
  id: string;
  providerId: string;
  name: string;
  kind: string;
  encryptionKeyId: string;
  algorithm: string;
  createdAt: string;
  updatedAt: string;
}

export interface EncryptedCredentialRecord extends CredentialRecord {
  encryptedPayload: string;
}

export interface ChannelRecord {
  id: string;
  providerId: string;
  providerType: string;
  providerEnabled: boolean;
  providerConfig: Record<string, unknown>;
  credentialId?: string;
  name: string;
  enabled: boolean;
  priority: number;
  weight: number;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeChannelRecord extends ChannelRecord {
  credential?: EncryptedCredentialRecord;
}

export interface CreateProviderInput {
  id: string;
  type: string;
  displayName: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface CreateCredentialInput {
  id: string;
  providerId: string;
  name: string;
  kind?: string;
  encryptedPayload: string;
  encryptionKeyId: string;
  algorithm: string;
}

export interface CreateChannelInput {
  id: string;
  providerId: string;
  credentialId?: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  config?: Record<string, unknown>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_tenants (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_projects (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS gateway_virtual_keys (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE CASCADE,
  project_id text,
  name text NOT NULL,
  key_hash char(64) NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES gateway_projects(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS gateway_virtual_keys_tenant_idx ON gateway_virtual_keys(tenant_id);
CREATE INDEX IF NOT EXISTS gateway_virtual_keys_project_idx ON gateway_virtual_keys(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gateway_providers (
  id text PRIMARY KEY,
  type text NOT NULL UNIQUE,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_credentials (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES gateway_providers(id) ON DELETE RESTRICT,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'generic',
  encrypted_payload text NOT NULL,
  encryption_key_id text NOT NULL,
  algorithm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, id)
);

CREATE INDEX IF NOT EXISTS gateway_credentials_provider_idx ON gateway_credentials(provider_id);
CREATE INDEX IF NOT EXISTS gateway_credentials_key_id_idx ON gateway_credentials(encryption_key_id);

CREATE TABLE IF NOT EXISTS gateway_channels (
  id text PRIMARY KEY,
  provider_id text NOT NULL REFERENCES gateway_providers(id) ON DELETE RESTRICT,
  credential_id text,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100,
  weight integer NOT NULL DEFAULT 100 CHECK (weight > 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider_id, credential_id) REFERENCES gateway_credentials(provider_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS gateway_channels_provider_idx ON gateway_channels(provider_id);
CREATE INDEX IF NOT EXISTS gateway_channels_enabled_idx ON gateway_channels(enabled, priority);

CREATE TABLE IF NOT EXISTS gateway_sessions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE RESTRICT,
  project_id text,
  virtual_key_id text REFERENCES gateway_virtual_keys(id) ON DELETE SET NULL,
  provider text NOT NULL,
  channel_id text NOT NULL,
  provider_session_id text,
  binding_state text NOT NULL CHECK (binding_state IN ('creating', 'bound', 'failed')),
  last_error text,
  budget jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES gateway_projects(tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS gateway_sessions_provider_binding_idx
  ON gateway_sessions(channel_id, provider_session_id) WHERE provider_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gateway_sessions_tenant_updated_idx ON gateway_sessions(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gateway_idempotency (
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE CASCADE,
  virtual_key_id text NOT NULL REFERENCES gateway_virtual_keys(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, virtual_key_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gateway_idempotency_expiry_idx ON gateway_idempotency(expires_at);
`;

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function sessionFromRow(row: Record<string, any>): SessionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    virtualKeyId: row.virtual_key_id ? String(row.virtual_key_id) : undefined,
    provider: String(row.provider),
    channelId: String(row.channel_id),
    providerSessionId: row.provider_session_id ? String(row.provider_session_id) : undefined,
    state: row.binding_state,
    lastError: row.last_error ? String(row.last_error) : undefined,
    budget: row.budget ?? undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function providerFromRow(row: Record<string, any>): ProviderRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    displayName: String(row.display_name),
    enabled: Boolean(row.enabled),
    config: row.config ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function credentialFromRow(row: Record<string, any>): EncryptedCredentialRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    name: String(row.name),
    kind: String(row.kind),
    encryptedPayload: String(row.encrypted_payload),
    encryptionKeyId: String(row.encryption_key_id),
    algorithm: String(row.algorithm),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function channelFromRow(row: Record<string, any>): ChannelRecord {
  return {
    id: String(row.id),
    providerId: String(row.provider_id),
    providerType: String(row.provider_type),
    providerEnabled: Boolean(row.provider_enabled),
    providerConfig: row.provider_config ?? {},
    credentialId: row.credential_id ? String(row.credential_id) : undefined,
    name: String(row.name),
    enabled: Boolean(row.enabled),
    priority: Number(row.priority),
    weight: Number(row.weight),
    config: row.config ?? {},
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PostgresGatewayStore implements SessionStore, VirtualKeyLookupStore, IdempotencyStore {
  readonly pool: Pool;

  constructor(config: string | PoolConfig) {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async close() { await this.pool.end(); }
  async migrate() { await this.pool.query(SCHEMA_SQL); }

  async health() {
    const result = await this.pool.query<{ now: Date }>("SELECT now() AS now");
    return { ok: true, now: result.rows[0]?.now?.toISOString?.() ?? String(result.rows[0]?.now) };
  }

  async seedDevelopmentIdentity(input: {
    tenantId: string;
    tenantName?: string;
    projectId: string;
    projectName?: string;
    virtualKeyId: string;
    virtualKeyName?: string;
    secret: string;
  }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO gateway_tenants(id, name) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = now()`,
        [input.tenantId, input.tenantName ?? "Development tenant"],
      );
      await client.query(
        `INSERT INTO gateway_projects(id, tenant_id, name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active', updated_at = now()`,
        [input.projectId, input.tenantId, input.projectName ?? "Development project"],
      );
      await client.query(
        `INSERT INTO gateway_virtual_keys(id, tenant_id, project_id, name, key_hash, key_prefix, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, project_id = EXCLUDED.project_id,
           name = EXCLUDED.name, key_hash = EXCLUDED.key_hash, key_prefix = EXCLUDED.key_prefix,
           enabled = true, updated_at = now()`,
        [input.virtualKeyId, input.tenantId, input.projectId, input.virtualKeyName ?? "Development key",
          hashVirtualKey(input.secret), input.secret.slice(0, 10)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async create(record: SessionRecord) {
    await this.pool.query(
      `INSERT INTO gateway_sessions(id, tenant_id, project_id, virtual_key_id, provider, channel_id,
        provider_session_id, binding_state, last_error, budget, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [record.id, record.tenantId, record.projectId ?? null, record.virtualKeyId ?? null, record.provider,
        record.channelId, record.providerSessionId ?? null, record.state, record.lastError ?? null,
        record.budget ? JSON.stringify(record.budget) : null, record.createdAt, record.updatedAt],
    );
  }

  async get(id: string) {
    const result = await this.pool.query("SELECT * FROM gateway_sessions WHERE id = $1", [id]);
    return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
  }

  async update(record: SessionRecord) {
    const result = await this.pool.query(
      `UPDATE gateway_sessions SET provider_session_id=$2, binding_state=$3, last_error=$4,
        budget=$5::jsonb, updated_at=$6 WHERE id=$1`,
      [record.id, record.providerSessionId ?? null, record.state, record.lastError ?? null,
        record.budget ? JSON.stringify(record.budget) : null, record.updatedAt],
    );
    if (result.rowCount !== 1) throw new Error(`Unknown session: ${record.id}`);
  }

  async findVirtualKeyByHash(keyHash: string): Promise<VirtualKeyIdentity | undefined> {
    const result = await this.pool.query(
      `SELECT vk.id, vk.tenant_id, vk.project_id, vk.enabled, vk.expires_at
       FROM gateway_virtual_keys vk
       JOIN gateway_tenants t ON t.id = vk.tenant_id AND t.status = 'active'
       LEFT JOIN gateway_projects p ON p.id = vk.project_id AND p.tenant_id = vk.tenant_id
       WHERE vk.key_hash=$1 AND vk.enabled=true AND (vk.expires_at IS NULL OR vk.expires_at > now())
         AND (vk.project_id IS NULL OR p.status='active')`, [keyHash]);
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: String(row.id), tenantId: String(row.tenant_id),
      projectId: row.project_id ? String(row.project_id) : undefined, enabled: Boolean(row.enabled),
      expiresAt: row.expires_at ? iso(row.expires_at) : undefined };
  }

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM gateway_idempotency WHERE tenant_id=$1 AND virtual_key_id=$2 AND scope=$3
          AND idempotency_key=$4 AND expires_at <= now()`,
        [input.tenantId, input.virtualKeyId, input.scope, input.key]);
      const inserted = await client.query(
        `INSERT INTO gateway_idempotency(tenant_id,virtual_key_id,scope,idempotency_key,request_hash,state,expires_at)
         VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT DO NOTHING RETURNING request_hash`,
        [input.tenantId, input.virtualKeyId, input.scope, input.key, input.requestHash, input.expiresAt]);
      if (inserted.rowCount === 1) { await client.query("COMMIT"); return { state: "claimed" }; }
      const existing = await client.query(
        `SELECT request_hash,state,response_status,response_body FROM gateway_idempotency
         WHERE tenant_id=$1 AND virtual_key_id=$2 AND scope=$3 AND idempotency_key=$4 FOR UPDATE`,
        [input.tenantId, input.virtualKeyId, input.scope, input.key]);
      await client.query("COMMIT");
      const row = existing.rows[0];
      if (!row) return { state: "in_progress" };
      if (row.request_hash !== input.requestHash) return { state: "conflict" };
      if (row.state === "completed") return { state: "replay", responseStatus: Number(row.response_status ?? 200), responseBody: row.response_body };
      return { state: "in_progress" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async complete(input: { tenantId: string; virtualKeyId: string; scope: string; key: string;
    responseStatus: number; responseBody: unknown; expiresAt?: string }) {
    const result = await this.pool.query(
      `UPDATE gateway_idempotency SET state='completed', response_status=$5, response_body=$6::jsonb,
        expires_at=COALESCE($7::timestamptz,expires_at), updated_at=now()
       WHERE tenant_id=$1 AND virtual_key_id=$2 AND scope=$3 AND idempotency_key=$4`,
      [input.tenantId,input.virtualKeyId,input.scope,input.key,input.responseStatus,
        JSON.stringify(input.responseBody),input.expiresAt ?? null]);
    if (result.rowCount !== 1) throw new Error("Idempotency claim not found");
  }

  async createTenant(input: { id: string; name: string }): Promise<TenantRecord> {
    const result = await this.pool.query(`INSERT INTO gateway_tenants(id,name) VALUES ($1,$2) RETURNING id,name,status,created_at`, [input.id,input.name]);
    const row = result.rows[0];
    return { id: row.id, name: row.name, status: row.status, createdAt: iso(row.created_at) };
  }

  async createProject(input: { id: string; tenantId: string; name: string }): Promise<ProjectRecord> {
    const result = await this.pool.query(`INSERT INTO gateway_projects(id,tenant_id,name) VALUES ($1,$2,$3) RETURNING id,tenant_id,name,status,created_at`, [input.id,input.tenantId,input.name]);
    const row = result.rows[0];
    return { id: row.id, tenantId: row.tenant_id, name: row.name, status: row.status, createdAt: iso(row.created_at) };
  }

  async createVirtualKey(input: CreateVirtualKeyInput): Promise<StoredVirtualKeyRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_virtual_keys(id,tenant_id,project_id,name,key_hash,key_prefix,enabled,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7)
       RETURNING id,tenant_id,project_id,name,key_prefix,enabled,expires_at,created_at`,
      [input.id,input.tenantId,input.projectId ?? null,input.name,input.keyHash,input.keyPrefix,input.expiresAt ?? null]);
    const row = result.rows[0];
    return { id: row.id, tenantId: row.tenant_id, projectId: row.project_id ?? undefined, name: row.name,
      keyPrefix: row.key_prefix, enabled: row.enabled, expiresAt: row.expires_at ? iso(row.expires_at) : undefined,
      createdAt: iso(row.created_at) };
  }

  async createProvider(input: CreateProviderInput): Promise<ProviderRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_providers(id,type,display_name,enabled,config) VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING *`,
      [input.id,input.type,input.displayName,input.enabled ?? true,JSON.stringify(input.config ?? {})]);
    return providerFromRow(result.rows[0]);
  }

  async upsertProvider(input: CreateProviderInput): Promise<ProviderRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_providers(id,type,display_name,enabled,config) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, display_name=EXCLUDED.display_name,
         enabled=EXCLUDED.enabled, config=EXCLUDED.config, updated_at=now() RETURNING *`,
      [input.id,input.type,input.displayName,input.enabled ?? true,JSON.stringify(input.config ?? {})]);
    return providerFromRow(result.rows[0]);
  }

  async updateProvider(id: string, patch: { displayName?: string; enabled?: boolean; config?: Record<string, unknown> }) {
    const result = await this.pool.query(
      `UPDATE gateway_providers SET display_name=COALESCE($2,display_name), enabled=COALESCE($3,enabled),
        config=COALESCE($4::jsonb,config), updated_at=now() WHERE id=$1 RETURNING *`,
      [id,patch.displayName ?? null,patch.enabled ?? null,patch.config ? JSON.stringify(patch.config) : null]);
    if (!result.rows[0]) throw new Error(`Provider not found: ${id}`);
    return providerFromRow(result.rows[0]);
  }

  async listProviders() {
    const result = await this.pool.query(`SELECT * FROM gateway_providers ORDER BY created_at,id`);
    return result.rows.map(providerFromRow);
  }

  async createCredential(input: CreateCredentialInput): Promise<CredentialRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_credentials(id,provider_id,name,kind,encrypted_payload,encryption_key_id,algorithm)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [input.id,input.providerId,input.name,input.kind ?? "generic",input.encryptedPayload,input.encryptionKeyId,input.algorithm]);
    const { encryptedPayload: _secret, ...redacted } = credentialFromRow(result.rows[0]);
    return redacted;
  }

  async upsertCredential(input: CreateCredentialInput): Promise<CredentialRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_credentials(id,provider_id,name,kind,encrypted_payload,encryption_key_id,algorithm)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id,name=EXCLUDED.name,kind=EXCLUDED.kind,
         encrypted_payload=EXCLUDED.encrypted_payload,encryption_key_id=EXCLUDED.encryption_key_id,
         algorithm=EXCLUDED.algorithm,updated_at=now() RETURNING *`,
      [input.id,input.providerId,input.name,input.kind ?? "generic",input.encryptedPayload,input.encryptionKeyId,input.algorithm]);
    const { encryptedPayload: _secret, ...redacted } = credentialFromRow(result.rows[0]);
    return redacted;
  }

  async getEncryptedCredential(id: string) {
    const result = await this.pool.query(`SELECT * FROM gateway_credentials WHERE id=$1`, [id]);
    return result.rows[0] ? credentialFromRow(result.rows[0]) : undefined;
  }

  async listCredentials(): Promise<CredentialRecord[]> {
    const result = await this.pool.query(`SELECT * FROM gateway_credentials ORDER BY created_at,id`);
    return result.rows.map((row) => { const { encryptedPayload: _secret, ...redacted } = credentialFromRow(row); return redacted; });
  }

  async updateCredentialEnvelope(id: string, input: { encryptedPayload: string; encryptionKeyId: string; algorithm: string }) {
    const result = await this.pool.query(
      `UPDATE gateway_credentials SET encrypted_payload=$2,encryption_key_id=$3,algorithm=$4,updated_at=now()
       WHERE id=$1 RETURNING *`, [id,input.encryptedPayload,input.encryptionKeyId,input.algorithm]);
    if (!result.rows[0]) throw new Error(`Credential not found: ${id}`);
    const { encryptedPayload: _secret, ...redacted } = credentialFromRow(result.rows[0]);
    return redacted;
  }

  async createChannel(input: CreateChannelInput): Promise<ChannelRecord> {
    const result = await this.pool.query(
      `INSERT INTO gateway_channels(id,provider_id,credential_id,name,enabled,priority,weight,config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [input.id,input.providerId,input.credentialId ?? null,input.name,input.enabled ?? true,
        input.priority ?? 100,input.weight ?? 100,JSON.stringify(input.config ?? {})]);
    return (await this.getChannel(result.rows[0].id))!;
  }

  async upsertChannel(input: CreateChannelInput): Promise<ChannelRecord> {
    await this.pool.query(
      `INSERT INTO gateway_channels(id,provider_id,credential_id,name,enabled,priority,weight,config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (id) DO UPDATE SET provider_id=EXCLUDED.provider_id,credential_id=EXCLUDED.credential_id,
         name=EXCLUDED.name,enabled=EXCLUDED.enabled,priority=EXCLUDED.priority,weight=EXCLUDED.weight,
         config=EXCLUDED.config,updated_at=now()`,
      [input.id,input.providerId,input.credentialId ?? null,input.name,input.enabled ?? true,
        input.priority ?? 100,input.weight ?? 100,JSON.stringify(input.config ?? {})]);
    return (await this.getChannel(input.id))!;
  }

  async getChannel(id: string): Promise<ChannelRecord | undefined> {
    const result = await this.pool.query(
      `SELECT c.*,p.type AS provider_type,p.enabled AS provider_enabled,p.config AS provider_config
       FROM gateway_channels c JOIN gateway_providers p ON p.id=c.provider_id WHERE c.id=$1`, [id]);
    return result.rows[0] ? channelFromRow(result.rows[0]) : undefined;
  }

  async updateChannel(id: string, patch: { credentialId?: string | null; name?: string; enabled?: boolean;
    priority?: number; weight?: number; config?: Record<string, unknown> }) {
    const result = await this.pool.query(
      `UPDATE gateway_channels SET credential_id=CASE WHEN $2::boolean THEN $3 ELSE credential_id END,
        name=COALESCE($4,name),enabled=COALESCE($5,enabled),priority=COALESCE($6,priority),
        weight=COALESCE($7,weight),config=COALESCE($8::jsonb,config),updated_at=now() WHERE id=$1 RETURNING id`,
      [id,Object.prototype.hasOwnProperty.call(patch,"credentialId"),patch.credentialId ?? null,patch.name ?? null,
        patch.enabled ?? null,patch.priority ?? null,patch.weight ?? null,patch.config ? JSON.stringify(patch.config) : null]);
    if (!result.rows[0]) throw new Error(`Channel not found: ${id}`);
    return (await this.getChannel(id))!;
  }

  async listChannels(): Promise<ChannelRecord[]> {
    const result = await this.pool.query(
      `SELECT c.*,p.type AS provider_type,p.enabled AS provider_enabled,p.config AS provider_config
       FROM gateway_channels c JOIN gateway_providers p ON p.id=c.provider_id ORDER BY c.priority,c.id`);
    return result.rows.map(channelFromRow);
  }

  async listRuntimeChannels(): Promise<RuntimeChannelRecord[]> {
    const result = await this.pool.query(
      `SELECT c.*,p.type AS provider_type,p.enabled AS provider_enabled,p.config AS provider_config,
        cr.id AS cr_id,cr.provider_id AS cr_provider_id,cr.name AS cr_name,cr.kind AS cr_kind,
        cr.encrypted_payload AS cr_encrypted_payload,cr.encryption_key_id AS cr_encryption_key_id,
        cr.algorithm AS cr_algorithm,cr.created_at AS cr_created_at,cr.updated_at AS cr_updated_at
       FROM gateway_channels c
       JOIN gateway_providers p ON p.id=c.provider_id
       LEFT JOIN gateway_credentials cr ON cr.id=c.credential_id AND cr.provider_id=c.provider_id
       ORDER BY c.priority,c.id`);
    return result.rows.map((row) => {
      const channel = channelFromRow(row) as RuntimeChannelRecord;
      if (row.cr_id) {
        channel.credential = {
          id: String(row.cr_id), providerId: String(row.cr_provider_id), name: String(row.cr_name),
          kind: String(row.cr_kind), encryptedPayload: String(row.cr_encrypted_payload),
          encryptionKeyId: String(row.cr_encryption_key_id), algorithm: String(row.cr_algorithm),
          createdAt: iso(row.cr_created_at), updatedAt: iso(row.cr_updated_at),
        };
      }
      return channel;
    });
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
