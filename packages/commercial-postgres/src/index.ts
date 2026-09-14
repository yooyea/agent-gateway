import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";

export type PlanStatus = "active" | "archived";
export type BillingInterval = "month" | "year";
export type SubscriptionStatus = "scheduled" | "active" | "canceled";

export interface PlanRecord {
  id: string;
  name: string;
  description?: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PlanVersionRecord {
  id: string;
  planId: string;
  version: number;
  currency: string;
  billingInterval: BillingInterval;
  recurringPriceMicros: string;
  includedCreditMicros: string;
  defaultSessionBudgetMicros?: string;
  requestsPerMinute?: number;
  maxConcurrency?: number;
  entitlements: Record<string, unknown>;
  effectiveFrom: string;
  createdAt: string;
}

export interface SubscriptionRecord {
  id: string;
  tenantId: string;
  planVersionId: string;
  status: SubscriptionStatus;
  startsAt: string;
  endsAt?: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  canceledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommercialPolicy {
  tenantId: string;
  subscriptionId: string;
  planId: string;
  planVersionId: string;
  includedCreditMicros: string;
  defaultSessionBudgetMicros?: string;
  requestsPerMinute?: number;
  maxConcurrency?: number;
  entitlements: Record<string, unknown>;
  periodStart: string;
  periodEnd: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS gateway_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_plan_versions (
  id text PRIMARY KEY,
  plan_id text NOT NULL REFERENCES gateway_plans(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  currency text NOT NULL DEFAULT 'USD',
  billing_interval text NOT NULL CHECK (billing_interval IN ('month','year')),
  recurring_price_micros bigint NOT NULL DEFAULT 0 CHECK (recurring_price_micros >= 0),
  included_credit_micros bigint NOT NULL DEFAULT 0 CHECK (included_credit_micros >= 0),
  default_session_budget_micros bigint CHECK (default_session_budget_micros > 0),
  requests_per_minute integer CHECK (requests_per_minute > 0),
  max_concurrency integer CHECK (max_concurrency > 0),
  entitlements jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

CREATE INDEX IF NOT EXISTS gateway_plan_versions_plan_idx
  ON gateway_plan_versions(plan_id, version DESC);

CREATE TABLE IF NOT EXISTS gateway_subscriptions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES gateway_tenants(id) ON DELETE RESTRICT,
  plan_version_id text NOT NULL REFERENCES gateway_plan_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('scheduled','active','canceled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  CHECK (current_period_end > current_period_start)
);

CREATE INDEX IF NOT EXISTS gateway_subscriptions_tenant_idx
  ON gateway_subscriptions(tenant_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS gateway_subscriptions_plan_version_idx
  ON gateway_subscriptions(plan_version_id);

CREATE OR REPLACE FUNCTION gateway_reject_plan_version_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway_plan_versions is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_plan_versions_no_update ON gateway_plan_versions;
CREATE TRIGGER gateway_plan_versions_no_update
  BEFORE UPDATE ON gateway_plan_versions
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_plan_version_mutation();

DROP TRIGGER IF EXISTS gateway_plan_versions_no_delete ON gateway_plan_versions;
CREATE TRIGGER gateway_plan_versions_no_delete
  BEFORE DELETE ON gateway_plan_versions
  FOR EACH ROW EXECUTE FUNCTION gateway_reject_plan_version_mutation();

CREATE OR REPLACE FUNCTION gateway_restrict_subscription_identity_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.plan_version_id <> OLD.plan_version_id
     OR NEW.starts_at <> OLD.starts_at THEN
    RAISE EXCEPTION 'subscription commercial identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gateway_subscriptions_identity_guard ON gateway_subscriptions;
CREATE TRIGGER gateway_subscriptions_identity_guard
  BEFORE UPDATE ON gateway_subscriptions
  FOR EACH ROW EXECUTE FUNCTION gateway_restrict_subscription_identity_mutation();
`;

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function planFromRow(row: Record<string, any>): PlanRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function versionFromRow(row: Record<string, any>): PlanVersionRecord {
  return {
    id: String(row.id),
    planId: String(row.plan_id),
    version: Number(row.version),
    currency: String(row.currency),
    billingInterval: row.billing_interval,
    recurringPriceMicros: String(row.recurring_price_micros),
    includedCreditMicros: String(row.included_credit_micros),
    defaultSessionBudgetMicros: row.default_session_budget_micros == null
      ? undefined : String(row.default_session_budget_micros),
    requestsPerMinute: row.requests_per_minute == null ? undefined : Number(row.requests_per_minute),
    maxConcurrency: row.max_concurrency == null ? undefined : Number(row.max_concurrency),
    entitlements: row.entitlements ?? {},
    effectiveFrom: iso(row.effective_from),
    createdAt: iso(row.created_at),
  };
}

function subscriptionFromRow(row: Record<string, any>): SubscriptionRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    planVersionId: String(row.plan_version_id),
    status: row.status,
    startsAt: iso(row.starts_at),
    endsAt: row.ends_at ? iso(row.ends_at) : undefined,
    currentPeriodStart: iso(row.current_period_start),
    currentPeriodEnd: iso(row.current_period_end),
    canceledAt: row.canceled_at ? iso(row.canceled_at) : undefined,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function integerMicros(value: bigint | string | undefined, fallback = 0n) {
  const result = value == null ? fallback : BigInt(value);
  if (result < 0n) throw new Error("money micros must be non-negative");
  return result.toString();
}

function positiveInteger(value: number | undefined, name: string) {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function addBillingInterval(start: Date, interval: BillingInterval) {
  const end = new Date(start);
  if (interval === "month") end.setUTCMonth(end.getUTCMonth() + 1);
  else end.setUTCFullYear(end.getUTCFullYear() + 1);
  return end;
}

export class PostgresCommercialStore {
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

  async createPlan(input: { id?: string; name: string; description?: string }) {
    const id = input.id ?? `agplan_${randomUUID().replaceAll("-", "")}`;
    const result = await this.pool.query(
      `INSERT INTO gateway_plans(id,name,description) VALUES ($1,$2,$3) RETURNING *`,
      [id,input.name,input.description ?? null],
    );
    return planFromRow(result.rows[0]);
  }

  async listPlans() {
    const result = await this.pool.query(`SELECT * FROM gateway_plans ORDER BY created_at DESC,id`);
    return result.rows.map(planFromRow);
  }

  async setPlanStatus(id: string, status: PlanStatus) {
    const result = await this.pool.query(
      `UPDATE gateway_plans SET status=$2,updated_at=now() WHERE id=$1 RETURNING *`, [id,status]);
    if (!result.rows[0]) throw new Error(`Plan not found: ${id}`);
    return planFromRow(result.rows[0]);
  }

  async createPlanVersion(input: {
    id?: string;
    planId: string;
    currency?: string;
    billingInterval: BillingInterval;
    recurringPriceMicros?: bigint | string;
    includedCreditMicros?: bigint | string;
    defaultSessionBudgetMicros?: bigint | string;
    requestsPerMinute?: number;
    maxConcurrency?: number;
    entitlements?: Record<string, unknown>;
    effectiveFrom?: string;
  }) {
    const id = input.id ?? `agplanv_${randomUUID().replaceAll("-", "")}`;
    return this.withTransaction(async (client) => {
      const plan = await client.query(`SELECT id,status FROM gateway_plans WHERE id=$1 FOR UPDATE`, [input.planId]);
      if (!plan.rows[0]) throw new Error(`Plan not found: ${input.planId}`);
      if (plan.rows[0].status !== "active") throw new Error(`Plan is not active: ${input.planId}`);
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version),0)+1 AS version FROM gateway_plan_versions WHERE plan_id=$1`, [input.planId]);
      const defaultBudget = input.defaultSessionBudgetMicros == null
        ? null : BigInt(input.defaultSessionBudgetMicros).toString();
      if (defaultBudget !== null && BigInt(defaultBudget) <= 0n) {
        throw new Error("defaultSessionBudgetMicros must be positive");
      }
      const result = await client.query(
        `INSERT INTO gateway_plan_versions(
          id,plan_id,version,currency,billing_interval,recurring_price_micros,included_credit_micros,
          default_session_budget_micros,requests_per_minute,max_concurrency,entitlements,effective_from
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`,
        [
          id,input.planId,Number(next.rows[0]?.version ?? 1),input.currency ?? "USD",input.billingInterval,
          integerMicros(input.recurringPriceMicros),integerMicros(input.includedCreditMicros),defaultBudget,
          positiveInteger(input.requestsPerMinute,"requestsPerMinute") ?? null,
          positiveInteger(input.maxConcurrency,"maxConcurrency") ?? null,
          JSON.stringify(input.entitlements ?? {}),input.effectiveFrom ?? new Date().toISOString(),
        ],
      );
      return versionFromRow(result.rows[0]);
    });
  }

  async listPlanVersions(planId: string) {
    const result = await this.pool.query(
      `SELECT * FROM gateway_plan_versions WHERE plan_id=$1 ORDER BY version DESC`, [planId]);
    return result.rows.map(versionFromRow);
  }

  async getPlanVersion(id: string) {
    const result = await this.pool.query(`SELECT * FROM gateway_plan_versions WHERE id=$1`, [id]);
    return result.rows[0] ? versionFromRow(result.rows[0]) : undefined;
  }

  async createSubscription(input: {
    id?: string;
    tenantId: string;
    planVersionId: string;
    startsAt?: string;
    endsAt?: string;
  }) {
    const id = input.id ?? `agsub_${randomUUID().replaceAll("-", "")}`;
    const startsAt = new Date(input.startsAt ?? new Date().toISOString());
    if (!Number.isFinite(startsAt.getTime())) throw new Error("startsAt must be an ISO timestamp");
    const endsAt = input.endsAt ? new Date(input.endsAt) : undefined;
    if (endsAt && (!Number.isFinite(endsAt.getTime()) || endsAt <= startsAt)) {
      throw new Error("endsAt must be after startsAt");
    }

    return this.withTransaction(async (client) => {
      const tenant = await client.query(`SELECT id FROM gateway_tenants WHERE id=$1 FOR UPDATE`, [input.tenantId]);
      if (!tenant.rows[0]) throw new Error(`Tenant not found: ${input.tenantId}`);
      const version = await client.query(
        `SELECT pv.*,p.status AS plan_status FROM gateway_plan_versions pv
         JOIN gateway_plans p ON p.id=pv.plan_id WHERE pv.id=$1`, [input.planVersionId]);
      if (!version.rows[0]) throw new Error(`Plan version not found: ${input.planVersionId}`);
      if (version.rows[0].plan_status !== "active") throw new Error("Cannot subscribe to an archived Plan");
      if (new Date(version.rows[0].effective_from).getTime() > startsAt.getTime()) {
        throw new Error("Plan version is not effective at subscription start");
      }
      const overlap = await client.query(
        `SELECT id FROM gateway_subscriptions
         WHERE tenant_id=$1 AND status IN ('scheduled','active')
           AND tstzrange(starts_at,COALESCE(ends_at,'infinity'::timestamptz),'[)')
             && tstzrange($2::timestamptz,COALESCE($3::timestamptz,'infinity'::timestamptz),'[)')
         LIMIT 1`,
        [input.tenantId,startsAt.toISOString(),endsAt?.toISOString() ?? null],
      );
      if (overlap.rows[0]) throw new Error(`Tenant already has an overlapping subscription: ${overlap.rows[0].id}`);

      const interval = version.rows[0].billing_interval as BillingInterval;
      let periodEnd = addBillingInterval(startsAt, interval);
      if (endsAt && endsAt < periodEnd) periodEnd = endsAt;
      const status: SubscriptionStatus = startsAt.getTime() > Date.now() ? "scheduled" : "active";
      const result = await client.query(
        `INSERT INTO gateway_subscriptions(
          id,tenant_id,plan_version_id,status,starts_at,ends_at,current_period_start,current_period_end
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id,input.tenantId,input.planVersionId,status,startsAt.toISOString(),endsAt?.toISOString() ?? null,
          startsAt.toISOString(),periodEnd.toISOString()],
      );
      return subscriptionFromRow(result.rows[0]);
    });
  }

  async listSubscriptions(tenantId?: string) {
    const result = tenantId
      ? await this.pool.query(`SELECT * FROM gateway_subscriptions WHERE tenant_id=$1 ORDER BY starts_at DESC`, [tenantId])
      : await this.pool.query(`SELECT * FROM gateway_subscriptions ORDER BY starts_at DESC`);
    return result.rows.map(subscriptionFromRow);
  }

  async cancelSubscription(id: string, at = new Date().toISOString()) {
    const result = await this.pool.query(
      `UPDATE gateway_subscriptions
       SET status='canceled',canceled_at=$2,ends_at=LEAST(COALESCE(ends_at,$2::timestamptz),$2::timestamptz),updated_at=now()
       WHERE id=$1 AND status IN ('scheduled','active') RETURNING *`,
      [id,at],
    );
    if (!result.rows[0]) throw new Error(`Cancelable subscription not found: ${id}`);
    return subscriptionFromRow(result.rows[0]);
  }

  async resolvePolicy(tenantId: string, at = new Date().toISOString()): Promise<CommercialPolicy | undefined> {
    const result = await this.pool.query(
      `SELECT s.id AS subscription_id,s.tenant_id,s.current_period_start,s.current_period_end,
        pv.*,p.id AS resolved_plan_id
       FROM gateway_subscriptions s
       JOIN gateway_plan_versions pv ON pv.id=s.plan_version_id
       JOIN gateway_plans p ON p.id=pv.plan_id
       WHERE s.tenant_id=$1 AND s.status IN ('scheduled','active')
         AND s.starts_at <= $2::timestamptz
         AND (s.ends_at IS NULL OR s.ends_at > $2::timestamptz)
         AND pv.effective_from <= $2::timestamptz
       ORDER BY s.starts_at DESC LIMIT 1`,
      [tenantId,at],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tenantId: String(row.tenant_id),
      subscriptionId: String(row.subscription_id),
      planId: String(row.resolved_plan_id),
      planVersionId: String(row.id),
      includedCreditMicros: String(row.included_credit_micros),
      defaultSessionBudgetMicros: row.default_session_budget_micros == null
        ? undefined : String(row.default_session_budget_micros),
      requestsPerMinute: row.requests_per_minute == null ? undefined : Number(row.requests_per_minute),
      maxConcurrency: row.max_concurrency == null ? undefined : Number(row.max_concurrency),
      entitlements: row.entitlements ?? {},
      periodStart: iso(row.current_period_start),
      periodEnd: iso(row.current_period_end),
    };
  }
}
