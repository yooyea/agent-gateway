import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type UsageMetric =
  | "model.input_tokens"
  | "model.cached_input_tokens"
  | "model.output_tokens"
  | "sandbox.compute_seconds"
  | "web_search.call"
  | "file_search.call"
  | "tool.call"
  | "provider.other";

export type UsageFinality = "provisional" | "final" | "adjustment";
export type LedgerBook = "customer" | "upstream";
export type LedgerDirection = "debit" | "credit";
export type ReservationState = "active" | "released" | "settled" | "expired";
export type UsageSettlementState = "settled" | "no_price";

export interface NormalizedUsage {
  metric: UsageMetric;
  quantity: string;
}

export interface BillingAccountRecord {
  tenantId: string;
  currency: string;
  creditLimitMicros: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceRuleRecord {
  id: string;
  tenantId?: string;
  providerType?: string;
  model?: string;
  metric: UsageMetric;
  unitScale: string;
  upstreamPriceMicros?: string;
  customerPriceMicros?: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  createdAt: string;
}

export interface ReservationRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  sessionId?: string;
  requestRef: string;
  amountMicros: string;
  consumedMicros: string;
  currency: string;
  state: ReservationState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageObservationInput {
  tenantId: string;
  projectId?: string;
  sessionId: string;
  providerType: string;
  channelId: string;
  model?: string;
  usage: Record<string, unknown>;
  measuredAt?: string;
  finality?: UsageFinality;
  sourceRef?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageEventRecord {
  id: string;
  tenantId: string;
  projectId?: string;
  sessionId: string;
  providerType: string;
  channelId: string;
  model?: string;
  metric: UsageMetric;
  quantity: string;
  observationId: string;
  sourceRef?: string;
  measuredAt: string;
  finality: UsageFinality;
  settlementState: UsageSettlementState;
  settlementPriceRuleId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface LedgerEntryRecord {
  id: string;
  book: LedgerBook;
  tenantId?: string;
  providerType?: string;
  channelId?: string;
  sessionId?: string;
  usageEventId?: string;
  reservationId?: string;
  direction: LedgerDirection;
  amountMicros: string;
  currency: string;
  kind: string;
  priceSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export class BillingInsufficientFundsError extends Error {
  constructor(
    readonly availableMicros: bigint,
    readonly requestedMicros: bigint,
  ) {
    super(`Insufficient billing capacity: available=${availableMicros} requested=${requestedMicros}`);
    this.name = "BillingInsufficientFundsError";
  }
}

export class SessionBudgetExceededError extends Error {
  constructor(readonly sessionId: string, readonly remainingMicros: bigint) {
    super(`Session budget exhausted: ${sessionId}`);
    this.name = "SessionBudgetExceededError";
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_billing_accounts (
  tenant_id text PRIMARY KEY REFERENCES gateway_tenants(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD',
  credit_limit_micros bigint NOT NULL DEFAULT 0 CHECK (credit_limit_micros >= 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_price_rules (
  id text PRIMARY KEY,
  tenant_id text REFERENCES gateway_tenants(id) ON DELETE CASCADE,
  provider_type text,
  model text,
  metric text NOT NULL,
  unit_scale bigint NOT NULL CHECK (unit_scale > 0),
  upstream_price_micros bigint CHECK (upstream_price_micros IS NULL OR upstream_price_micros >= 0),
  customer_price_micros bigint CHECK (customer_price_micros IS NULL OR customer_price_micros >= 0),
  currency text NOT NULL DEFAULT 'USD',
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (upstream_price_micros IS NOT NULL OR customer_price_micros IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS gateway_price_rules_lookup_idx
  ON gateway_price_rules(metric, effective_from DESC);
CREATE INDEX IF NOT EXISTS gateway_price_rules_tenant_idx
  ON gateway_price_rules(tenant_id, metric, effective_from DESC)
  WHERE tenant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gateway_usage_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE RESTRICT,
  project_id text,
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  provider_type text NOT NULL,
  channel_id text NOT NULL,
  model text,
  metric text NOT NULL,
  quantity numeric(30,9) NOT NULL CHECK (quantity <> 0),
  observation_id text NOT NULL,
  source_ref text,
  measured_at timestamptz NOT NULL,
  finality text NOT NULL CHECK (finality IN ('provisional','final','adjustment')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES gateway_projects(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (observation_id, metric)
);

CREATE INDEX IF NOT EXISTS gateway_usage_events_session_idx
  ON gateway_usage_events(session_id, measured_at, created_at);
CREATE INDEX IF NOT EXISTS gateway_usage_events_tenant_idx
  ON gateway_usage_events(tenant_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS gateway_usage_settlements (
  usage_event_id text PRIMARY KEY REFERENCES gateway_usage_events(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('settled','no_price')),
  price_rule_id text REFERENCES gateway_price_rules(id) ON DELETE RESTRICT,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gateway_usage_settlements_state_idx
  ON gateway_usage_settlements(state, updated_at);

CREATE TABLE IF NOT EXISTS gateway_usage_counters (
  session_id text NOT NULL REFERENCES gateway_sessions(id) ON DELETE CASCADE,
  metric text NOT NULL,
  observed_quantity numeric(30,9) NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, metric)
);

ALTER TABLE gateway_usage_counters
  ADD COLUMN IF NOT EXISTS measured_at timestamptz;
UPDATE gateway_usage_counters
  SET measured_at = COALESCE(measured_at, '-infinity'::timestamptz)
  WHERE measured_at IS NULL;
ALTER TABLE gateway_usage_counters
  ALTER COLUMN measured_at SET DEFAULT '-infinity'::timestamptz;
ALTER TABLE gateway_usage_counters
  ALTER COLUMN measured_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS gateway_reservations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE RESTRICT,
  project_id text,
  session_id text UNIQUE REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  request_ref text NOT NULL,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  consumed_micros bigint NOT NULL DEFAULT 0 CHECK (consumed_micros >= 0),
  currency text NOT NULL DEFAULT 'USD',
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','settled','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES gateway_projects(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, request_ref)
);

CREATE INDEX IF NOT EXISTS gateway_reservations_active_idx
  ON gateway_reservations(tenant_id, expires_at)
  WHERE state = 'active';

CREATE TABLE IF NOT EXISTS gateway_ledger_entries (
  id text PRIMARY KEY,
  book text NOT NULL CHECK (book IN ('customer','upstream')),
  tenant_id text REFERENCES gateway_tenants(id) ON DELETE RESTRICT,
  provider_type text,
  channel_id text,
  session_id text REFERENCES gateway_sessions(id) ON DELETE RESTRICT,
  usage_event_id text REFERENCES gateway_usage_events(id) ON DELETE RESTRICT,
  reservation_id text REFERENCES gateway_reservations(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
  currency text NOT NULL DEFAULT 'USD',
  kind text NOT NULL,
  price_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book, idempotency_key)
);

CREATE INDEX IF NOT EXISTS gateway_ledger_customer_idx
  ON gateway_ledger_entries(tenant_id, created_at)
  WHERE book = 'customer';
CREATE INDEX IF NOT EXISTS gateway_ledger_session_idx
  ON gateway_ledger_entries(session_id, created_at)
  WHERE session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION gateway_reject_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_ledger_entries_no_update ON gateway_ledger_entries;
CREATE TRIGGER gateway_ledger_entries_no_update
  BEFORE UPDATE ON gateway_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_ledger_mutation();

DROP TRIGGER IF EXISTS gateway_ledger_entries_no_delete ON gateway_ledger_entries;
CREATE TRIGGER gateway_ledger_entries_no_delete
  BEFORE DELETE ON gateway_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_ledger_mutation();

CREATE OR REPLACE FUNCTION gateway_reject_usage_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_usage_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_usage_events_no_update ON gateway_usage_events;
CREATE TRIGGER gateway_usage_events_no_update
  BEFORE UPDATE ON gateway_usage_events
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_usage_mutation();

DROP TRIGGER IF EXISTS gateway_usage_events_no_delete ON gateway_usage_events;
CREATE TRIGGER gateway_usage_events_no_delete
  BEFORE DELETE ON gateway_usage_events
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_usage_mutation();
`;

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function accountFromRow(row: Record<string, any>): BillingAccountRecord {
  return {
    tenantId: String(row.tenant_id),
    currency: String(row.currency),
    creditLimitMicros: String(row.credit_limit_micros),
    enabled: Boolean(row.enabled),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function priceFromRow(row: Record<string, any>): PriceRuleRecord {
  return {
    id: String(row.id),
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    providerType: row.provider_type ? String(row.provider_type) : undefined,
    model: row.model ? String(row.model) : undefined,
    metric: row.metric,
    unitScale: String(row.unit_scale),
    upstreamPriceMicros: row.upstream_price_micros == null ? undefined : String(row.upstream_price_micros),
    customerPriceMicros: row.customer_price_micros == null ? undefined : String(row.customer_price_micros),
    currency: String(row.currency),
    effectiveFrom: iso(row.effective_from),
    effectiveTo: row.effective_to ? iso(row.effective_to) : undefined,
    createdAt: iso(row.created_at),
  };
}

function reservationFromRow(row: Record<string, any>): ReservationRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    requestRef: String(row.request_ref),
    amountMicros: String(row.amount_micros),
    consumedMicros: String(row.consumed_micros),
    currency: String(row.currency),
    state: row.state,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function usageFromRow(row: Record<string, any>): UsageEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: row.project_id ? String(row.project_id) : undefined,
    sessionId: String(row.session_id),
    providerType: String(row.provider_type),
    channelId: String(row.channel_id),
    model: row.model ? String(row.model) : undefined,
    metric: row.metric,
    quantity: String(row.quantity),
    observationId: String(row.observation_id),
    sourceRef: row.source_ref ? String(row.source_ref) : undefined,
    measuredAt: iso(row.measured_at),
    finality: row.finality,
    settlementState: row.settlement_state ?? "no_price",
    settlementPriceRuleId: row.settlement_price_rule_id ? String(row.settlement_price_rule_id) : undefined,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function ledgerFromRow(row: Record<string, any>): LedgerEntryRecord {
  return {
    id: String(row.id),
    book: row.book,
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
    providerType: row.provider_type ? String(row.provider_type) : undefined,
    channelId: row.channel_id ? String(row.channel_id) : undefined,
    sessionId: row.session_id ? String(row.session_id) : undefined,
    usageEventId: row.usage_event_id ? String(row.usage_event_id) : undefined,
    reservationId: row.reservation_id ? String(row.reservation_id) : undefined,
    direction: row.direction,
    amountMicros: String(row.amount_micros),
    currency: String(row.currency),
    kind: String(row.kind),
    priceSnapshot: row.price_snapshot ?? {},
    idempotencyKey: String(row.idempotency_key),
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

function numeric(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) return value;
  return undefined;
}

function nested(obj: Record<string, unknown>, ...path: string[]) {
  let current: unknown = obj;
  for (const part of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function normalizeUsageSnapshot(usage: Record<string, unknown>): NormalizedUsage[] {
  const out = new Map<UsageMetric, string>();
  const add = (metric: UsageMetric, value: unknown) => {
    const quantity = numeric(value);
    if (quantity !== undefined) out.set(metric, quantity);
  };

  add("model.input_tokens", usage.input_tokens);
  add("model.cached_input_tokens", usage.cached_input_tokens ?? nested(usage, "input_tokens_details", "cached_tokens"));
  add("model.output_tokens", usage.output_tokens);
  add("sandbox.compute_seconds", usage.sandbox_compute_seconds ?? usage.sandbox_seconds);
  add("web_search.call", usage.web_search_calls);
  add("file_search.call", usage.file_search_calls);
  add("tool.call", usage.tool_calls);

  return [...out.entries()].map(([metric, quantity]) => ({ metric, quantity }));
}

function observationId(input: UsageObservationInput) {
  const normalized = normalizeUsageSnapshot(input.usage).sort((a, b) => a.metric.localeCompare(b.metric));
  return `agobs_${createHash("sha256")
    .update(JSON.stringify({
      sessionId: input.sessionId,
      measuredAt: input.measuredAt ?? null,
      sourceRef: input.sourceRef ?? null,
      usage: normalized,
    }))
    .digest("hex")}`;
}

export function usdToMicros(value: number | string) {
  const text = String(value).trim();
  const match = text.match(/^(\d+)(?:\.(\d{0,6}))?$/);
  if (!match) throw new Error("USD value must be a non-negative decimal with at most 6 fractional digits");
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

export function microsToUsdString(value: bigint | string) {
  const amount = typeof value === "bigint" ? value : BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / 1_000_000n;
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function isNegativeDecimal(value: string) {
  return value.trim().startsWith("-");
}

export class PostgresBillingStore {
  readonly pool: Pool;

  constructor(config: string | PoolConfig) {
    this.pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  }

  async close() { await this.pool.end(); }
  async migrate() { await this.pool.query(SCHEMA_SQL); }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertAccount(input: {
    tenantId: string;
    currency?: string;
    creditLimitMicros?: bigint | string;
    enabled?: boolean;
  }) {
    const result = await this.pool.query(
      `INSERT INTO gateway_billing_accounts(tenant_id,currency,credit_limit_micros,enabled)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET currency=EXCLUDED.currency,
         credit_limit_micros=EXCLUDED.credit_limit_micros,enabled=EXCLUDED.enabled,updated_at=now()
       RETURNING *`,
      [input.tenantId,input.currency ?? "USD",String(input.creditLimitMicros ?? 0n),input.enabled ?? true],
    );
    return accountFromRow(result.rows[0]);
  }

  async getAccount(tenantId: string) {
    const result = await this.pool.query(`SELECT * FROM gateway_billing_accounts WHERE tenant_id=$1`, [tenantId]);
    return result.rows[0] ? accountFromRow(result.rows[0]) : undefined;
  }

  async createPriceRule(input: {
    id?: string;
    tenantId?: string;
    providerType?: string;
    model?: string;
    metric: UsageMetric;
    unitScale: bigint | string;
    upstreamPriceMicros?: bigint | string;
    customerPriceMicros?: bigint | string;
    currency?: string;
    effectiveFrom: string;
    effectiveTo?: string;
  }) {
    const id = input.id ?? `agprice_${randomUUID().replaceAll("-", "")}`;
    const result = await this.pool.query(
      `INSERT INTO gateway_price_rules(
        id,tenant_id,provider_type,model,metric,unit_scale,upstream_price_micros,
        customer_price_micros,currency,effective_from,effective_to
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,input.tenantId ?? null,input.providerType ?? null,input.model ?? null,input.metric,
        String(input.unitScale),input.upstreamPriceMicros == null ? null : String(input.upstreamPriceMicros),
        input.customerPriceMicros == null ? null : String(input.customerPriceMicros),input.currency ?? "USD",
        input.effectiveFrom,input.effectiveTo ?? null],
    );
    return priceFromRow(result.rows[0]);
  }

  async listPriceRules(tenantId?: string) {
    const result = tenantId
      ? await this.pool.query(`SELECT * FROM gateway_price_rules WHERE tenant_id IS NULL OR tenant_id=$1 ORDER BY metric,effective_from DESC`, [tenantId])
      : await this.pool.query(`SELECT * FROM gateway_price_rules ORDER BY metric,effective_from DESC`);
    return result.rows.map(priceFromRow);
  }

  private async accountExposure(client: PoolClient, tenantId: string) {
    const result = await client.query(
      `SELECT a.currency,a.credit_limit_micros,a.enabled,
        COALESCE((SELECT SUM(CASE WHEN direction='credit' THEN amount_micros ELSE -amount_micros END)
          FROM gateway_ledger_entries le WHERE le.book='customer' AND le.tenant_id=a.tenant_id),0)::bigint AS ledger_balance_micros,
        COALESCE((SELECT SUM(GREATEST(0,amount_micros-consumed_micros))
          FROM gateway_reservations r WHERE r.tenant_id=a.tenant_id AND r.state='active' AND r.expires_at > now()),0)::bigint AS reserved_micros
       FROM gateway_billing_accounts a WHERE a.tenant_id=$1 FOR UPDATE`,
      [tenantId],
    );
    if (!result.rows[0]) throw new Error(`Billing account not found: ${tenantId}`);
    const row = result.rows[0];
    return {
      currency: String(row.currency),
      enabled: Boolean(row.enabled),
      availableMicros: BigInt(row.credit_limit_micros) + BigInt(row.ledger_balance_micros) - BigInt(row.reserved_micros),
      reservedMicros: BigInt(row.reserved_micros),
      ledgerBalanceMicros: BigInt(row.ledger_balance_micros),
    };
  }

  async getAvailableMicros(tenantId: string) {
    const client = await this.pool.connect();
    try { return (await this.accountExposure(client, tenantId)).availableMicros; }
    finally { client.release(); }
  }

  async grantCredit(input: {
    tenantId: string;
    amountMicros: bigint | string;
    currency?: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  }) {
    const amount = BigInt(input.amountMicros);
    if (amount <= 0n) throw new Error("Credit amount must be positive");
    const result = await this.pool.query(
      `INSERT INTO gateway_ledger_entries(id,book,tenant_id,direction,amount_micros,currency,kind,price_snapshot,idempotency_key,metadata)
       VALUES ($1,'customer',$2,'credit',$3,$4,'credit.grant','{}'::jsonb,$5,$6::jsonb)
       ON CONFLICT (book,idempotency_key) DO NOTHING RETURNING *`,
      [`agled_${randomUUID().replaceAll("-", "")}`,input.tenantId,amount.toString(),input.currency ?? "USD",input.idempotencyKey,JSON.stringify(input.metadata ?? {})],
    );
    if (result.rows[0]) return ledgerFromRow(result.rows[0]);
    const existing = await this.pool.query(`SELECT * FROM gateway_ledger_entries WHERE book='customer' AND idempotency_key=$1`, [input.idempotencyKey]);
    return ledgerFromRow(existing.rows[0]);
  }

  async reserve(input: {
    tenantId: string;
    projectId?: string;
    requestRef: string;
    amountMicros: bigint | string;
    expiresAt: string;
  }) {
    const requested = BigInt(input.amountMicros);
    if (requested <= 0n) throw new Error("Reservation amount must be positive");
    return this.withTransaction(async (client) => {
      const existing = await client.query(`SELECT * FROM gateway_reservations WHERE tenant_id=$1 AND request_ref=$2`, [input.tenantId,input.requestRef]);
      if (existing.rows[0]) {
        const record = reservationFromRow(existing.rows[0]);
        if (BigInt(record.amountMicros) !== requested) throw new Error("Reservation request_ref conflict");
        return record;
      }
      const exposure = await this.accountExposure(client, input.tenantId);
      if (!exposure.enabled) throw new Error(`Billing account disabled: ${input.tenantId}`);
      if (exposure.availableMicros < requested) throw new BillingInsufficientFundsError(exposure.availableMicros, requested);
      const result = await client.query(
        `INSERT INTO gateway_reservations(id,tenant_id,project_id,request_ref,amount_micros,currency,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [`agres_${randomUUID().replaceAll("-", "")}`,input.tenantId,input.projectId ?? null,input.requestRef,requested.toString(),exposure.currency,input.expiresAt],
      );
      return reservationFromRow(result.rows[0]);
    });
  }

  async attachReservation(reservationId: string, sessionId: string) {
    const result = await this.pool.query(
      `UPDATE gateway_reservations SET session_id=$2,updated_at=now() WHERE id=$1 AND state='active' RETURNING *`,
      [reservationId,sessionId],
    );
    if (!result.rows[0]) throw new Error(`Active reservation not found: ${reservationId}`);
    return reservationFromRow(result.rows[0]);
  }

  async releaseReservation(reservationId: string, state: "released" | "expired" = "released") {
    const result = await this.pool.query(
      `UPDATE gateway_reservations SET state=$2,updated_at=now() WHERE id=$1 AND state='active' RETURNING *`,
      [reservationId,state],
    );
    return result.rows[0] ? reservationFromRow(result.rows[0]) : undefined;
  }

  async getSessionReservation(sessionId: string) {
    const result = await this.pool.query(`SELECT * FROM gateway_reservations WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    return result.rows[0] ? reservationFromRow(result.rows[0]) : undefined;
  }

  async assertSessionBudget(sessionId: string) {
    const reservation = await this.getSessionReservation(sessionId);
    if (!reservation) return { limited: false as const };
    const remaining = BigInt(reservation.amountMicros) - BigInt(reservation.consumedMicros);
    if (reservation.state !== "active" || new Date(reservation.expiresAt).getTime() <= Date.now() || remaining <= 0n) {
      throw new SessionBudgetExceededError(sessionId, remaining);
    }
    return { limited: true as const, remainingMicros: remaining, reservation };
  }

  private async findPriceRule(client: PoolClient, input: {
    tenantId: string;
    providerType: string;
    model?: string;
    metric: UsageMetric;
    measuredAt: string;
  }) {
    const result = await client.query(
      `SELECT * FROM gateway_price_rules WHERE metric=$1
       AND (tenant_id IS NULL OR tenant_id=$2) AND (provider_type IS NULL OR provider_type=$3)
       AND (model IS NULL OR model=$4) AND effective_from <= $5 AND (effective_to IS NULL OR effective_to > $5)
       ORDER BY (tenant_id IS NOT NULL) DESC,(provider_type IS NOT NULL) DESC,(model IS NOT NULL) DESC,effective_from DESC,created_at DESC LIMIT 1`,
      [input.metric,input.tenantId,input.providerType,input.model ?? null,input.measuredAt],
    );
    return result.rows[0] ? priceFromRow(result.rows[0]) : undefined;
  }

  private async insertLedgerForUsage(client: PoolClient, input: {
    event: UsageEventRecord;
    rule: PriceRuleRecord;
    book: LedgerBook;
    priceMicros?: string;
    reservationId?: string;
  }) {
    if (input.priceMicros == null) return undefined;
    const amount = await client.query<{ amount: string }>(
      `SELECT round(abs($1::numeric) * $2::numeric / $3::numeric)::bigint AS amount`,
      [input.event.quantity,input.priceMicros,input.rule.unitScale],
    );
    const amountMicros = BigInt(amount.rows[0]?.amount ?? "0");
    const direction: LedgerDirection = isNegativeDecimal(input.event.quantity) ? "credit" : "debit";
    const snapshot = {
      rule_id: input.rule.id,metric: input.rule.metric,unit_scale: input.rule.unitScale,
      unit_price_micros: input.priceMicros,provider_type: input.rule.providerType,model: input.rule.model,
      tenant_id: input.rule.tenantId,effective_from: input.rule.effectiveFrom,effective_to: input.rule.effectiveTo,
    };
    const key = `usage:${input.event.id}:${input.book}`;
    const result = await client.query(
      `INSERT INTO gateway_ledger_entries(
        id,book,tenant_id,provider_type,channel_id,session_id,usage_event_id,reservation_id,
        direction,amount_micros,currency,kind,price_snapshot,idempotency_key,metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,'{}'::jsonb)
       ON CONFLICT (book,idempotency_key) DO NOTHING RETURNING *`,
      [`agled_${randomUUID().replaceAll("-", "")}`,input.book,input.event.tenantId,input.event.providerType,
        input.event.channelId,input.event.sessionId,input.event.id,input.reservationId ?? null,direction,amountMicros.toString(),
        input.rule.currency,input.book === "customer" ? (direction === "debit" ? "usage.charge" : "usage.refund") : (direction === "debit" ? "usage.cost" : "reconciliation.adjustment"),
        JSON.stringify(snapshot),key],
    );
    return result.rows[0] ? ledgerFromRow(result.rows[0]) : undefined;
  }

  private async setSettlement(client: PoolClient, usageEventId: string, state: UsageSettlementState, priceRuleId?: string) {
    await client.query(
      `INSERT INTO gateway_usage_settlements(usage_event_id,state,price_rule_id,settled_at)
       VALUES ($1,$2,$3,CASE WHEN $2='settled' THEN now() ELSE NULL END)
       ON CONFLICT (usage_event_id) DO UPDATE SET state=EXCLUDED.state,price_rule_id=EXCLUDED.price_rule_id,
         settled_at=EXCLUDED.settled_at,updated_at=now()`,
      [usageEventId,state,priceRuleId ?? null],
    );
  }

  private async settleUsageEvent(client: PoolClient, event: UsageEventRecord) {
    const rule = await this.findPriceRule(client, {
      tenantId: event.tenantId,providerType: event.providerType,model: event.model,metric: event.metric,measuredAt: event.measuredAt,
    });
    if (!rule) {
      await this.setSettlement(client,event.id,"no_price");
      return { event: { ...event, settlementState: "no_price" as const }, ledger: [] as LedgerEntryRecord[] };
    }

    const reservationResult = await client.query(
      `SELECT * FROM gateway_reservations WHERE session_id=$1 AND state='active' LIMIT 1 FOR UPDATE`,
      [event.sessionId],
    );
    const reservation = reservationResult.rows[0] ? reservationFromRow(reservationResult.rows[0]) : undefined;
    const ledger = [
      await this.insertLedgerForUsage(client,{ event,rule,book:"upstream",priceMicros:rule.upstreamPriceMicros }),
      await this.insertLedgerForUsage(client,{ event,rule,book:"customer",priceMicros:rule.customerPriceMicros,reservationId:reservation?.id }),
    ].filter(Boolean) as LedgerEntryRecord[];

    const customerEntry = ledger.find((entry) => entry.book === "customer");
    if (reservation && customerEntry) {
      const signed = BigInt(customerEntry.amountMicros) * (customerEntry.direction === "debit" ? 1n : -1n);
      await client.query(
        `UPDATE gateway_reservations SET consumed_micros=GREATEST(0,consumed_micros + $2::bigint),updated_at=now() WHERE id=$1`,
        [reservation.id,signed.toString()],
      );
    }

    await this.setSettlement(client,event.id,"settled",rule.id);
    return {
      event: { ...event, settlementState: "settled" as const, settlementPriceRuleId: rule.id },
      ledger,
    };
  }

  async observeUsage(input: UsageObservationInput) {
    const normalized = normalizeUsageSnapshot(input.usage);
    if (!normalized.length) return { observationId: undefined, events: [] as UsageEventRecord[], ledger: [] as LedgerEntryRecord[] };
    const measuredAt = input.measuredAt ?? new Date().toISOString();
    const obsId = observationId({ ...input, measuredAt });

    return this.withTransaction(async (client) => {
      const events: UsageEventRecord[] = [];
      const ledger: LedgerEntryRecord[] = [];
      for (const item of normalized) {
        await client.query(
          `INSERT INTO gateway_usage_counters(session_id,metric,observed_quantity,measured_at)
           VALUES ($1,$2,0,'-infinity'::timestamptz)
           ON CONFLICT (session_id,metric) DO NOTHING`,
          [input.sessionId,item.metric],
        );
        const counter = await client.query(
          `SELECT observed_quantity,measured_at
           FROM gateway_usage_counters WHERE session_id=$1 AND metric=$2 FOR UPDATE`,
          [input.sessionId,item.metric],
        );
        const previous = String(counter.rows[0]?.observed_quantity ?? "0");
        const previousMeasuredAt = counter.rows[0]?.measured_at as Date | string | undefined;
        if (previousMeasuredAt && String(previousMeasuredAt) !== "-infinity") {
          const previousTime = new Date(previousMeasuredAt).getTime();
          const currentTime = new Date(measuredAt).getTime();
          if (Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime < previousTime) {
            continue;
          }
        }

        const deltaResult = await client.query<{ delta: string; delta_sign: string }>(
          `SELECT ($1::numeric-$2::numeric)::text AS delta,
            CASE WHEN $1::numeric-$2::numeric < 0 THEN '-1' WHEN $1::numeric-$2::numeric > 0 THEN '1' ELSE '0' END AS delta_sign`,
          [item.quantity,previous],
        );
        const delta = deltaResult.rows[0]?.delta ?? "0";
        const deltaSign = deltaResult.rows[0]?.delta_sign ?? "0";
        if (deltaSign === "0") {
          await client.query(
            `UPDATE gateway_usage_counters SET measured_at=$3,updated_at=now()
             WHERE session_id=$1 AND metric=$2`,
            [input.sessionId,item.metric,measuredAt],
          );
          continue;
        }

        const eventResult = await client.query(
          `INSERT INTO gateway_usage_events(
            id,tenant_id,project_id,session_id,provider_type,channel_id,model,metric,quantity,
            observation_id,source_ref,measured_at,finality,metadata
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12,$13,$14::jsonb)
           ON CONFLICT (observation_id,metric) DO NOTHING RETURNING *`,
          [`agusg_${randomUUID().replaceAll("-", "")}`,input.tenantId,input.projectId ?? null,input.sessionId,
            input.providerType,input.channelId,input.model ?? null,item.metric,delta,obsId,input.sourceRef ?? null,measuredAt,
            deltaSign === "-1" ? "adjustment" : (input.finality ?? "provisional"),JSON.stringify(input.metadata ?? {})],
        );
        if (!eventResult.rows[0]) continue;

        await client.query(
          `UPDATE gateway_usage_counters
           SET observed_quantity=$3::numeric,measured_at=$4,updated_at=now()
           WHERE session_id=$1 AND metric=$2`,
          [input.sessionId,item.metric,item.quantity,measuredAt],
        );
        const event = usageFromRow(eventResult.rows[0]);
        const settled = await this.settleUsageEvent(client,event);
        events.push(settled.event);
        ledger.push(...settled.ledger);
      }
      return { observationId: obsId,events,ledger };
    });
  }

  async settleUnpricedUsage(limit = 100) {
    const rows = await this.pool.query(
      `SELECT u.*,s.state AS settlement_state,s.price_rule_id AS settlement_price_rule_id
       FROM gateway_usage_events u
       JOIN gateway_usage_settlements s ON s.usage_event_id=u.id
       WHERE s.state='no_price'
       ORDER BY u.measured_at,u.created_at LIMIT $1`,
      [Math.max(1,Math.min(1000,limit))],
    );
    const settled: { event: UsageEventRecord; ledger: LedgerEntryRecord[] }[] = [];
    for (const row of rows.rows) {
      const result = await this.withTransaction((client) => this.settleUsageEvent(client,usageFromRow(row)));
      if (result.event.settlementState === "settled") settled.push(result);
    }
    return settled;
  }

  async listUsage(input: { tenantId?: string; sessionId?: string; limit?: number } = {}) {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.tenantId) { values.push(input.tenantId); clauses.push(`u.tenant_id=$${values.length}`); }
    if (input.sessionId) { values.push(input.sessionId); clauses.push(`u.session_id=$${values.length}`); }
    values.push(Math.max(1,Math.min(500,input.limit ?? 100)));
    const result = await this.pool.query(
      `SELECT u.*,COALESCE(s.state,'no_price') AS settlement_state,s.price_rule_id AS settlement_price_rule_id
       FROM gateway_usage_events u LEFT JOIN gateway_usage_settlements s ON s.usage_event_id=u.id
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY u.measured_at DESC,u.created_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(usageFromRow);
  }

  async listLedger(input: { tenantId?: string; sessionId?: string; book?: LedgerBook; limit?: number } = {}) {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.tenantId) { values.push(input.tenantId); clauses.push(`tenant_id=$${values.length}`); }
    if (input.sessionId) { values.push(input.sessionId); clauses.push(`session_id=$${values.length}`); }
    if (input.book) { values.push(input.book); clauses.push(`book=$${values.length}`); }
    values.push(Math.max(1,Math.min(500,input.limit ?? 100)));
    const result = await this.pool.query(
      `SELECT * FROM gateway_ledger_entries ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(ledgerFromRow);
  }
}
