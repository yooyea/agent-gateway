import type { GatewayRequestContext, SessionRecord, SessionStore } from "@agent-gateway/core";
import type { GatewaySession } from "@agent-gateway/protocol";
import {
  BillingInsufficientFundsError,
  PostgresBillingStore,
  SessionBudgetExceededError,
  usdToMicros,
  type BillingAccountRecord,
  type ReservationRecord,
  type UsageObservationInput,
} from "@agent-gateway/billing-postgres";

export interface BillingRuntimeStore {
  getAccount(tenantId: string): Promise<BillingAccountRecord | undefined>;
  reserve(input: {
    tenantId: string;
    projectId?: string;
    requestRef: string;
    amountMicros: bigint | string;
    expiresAt: string;
  }): Promise<ReservationRecord>;
  attachReservation(reservationId: string, sessionId: string): Promise<ReservationRecord>;
  releaseReservation(
    reservationId: string,
    state?: "released" | "expired",
  ): Promise<ReservationRecord | undefined>;
  getSessionReservation(sessionId: string): Promise<ReservationRecord | undefined>;
  assertSessionBudget(sessionId: string): Promise<
    | { limited: false }
    | { limited: true; remainingMicros: bigint; reservation: ReservationRecord }
  >;
  observeUsage(input: UsageObservationInput): Promise<unknown>;
}

export interface BillingSessionStoreOptions {
  reservationTtlSeconds?: number;
  requireBudgetForBilledTenant?: boolean;
}

export class SessionBudgetRequiredError extends Error {
  constructor(readonly tenantId: string) {
    super(`Session budget is required for billed tenant: ${tenantId}`);
    this.name = "SessionBudgetRequiredError";
  }
}

export class BillingPricingUnavailableError extends Error {
  constructor(readonly sessionId: string, readonly usageEventId?: string) {
    super(`Customer pricing is unavailable for billed session: ${sessionId}`);
    this.name = "BillingPricingUnavailableError";
  }
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function reservationExpiry(record: SessionRecord, fallbackSeconds: number) {
  const declared = record.budget?.max_duration_seconds;
  const seconds = typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? Math.max(fallbackSeconds, Math.ceil(declared))
    : fallbackSeconds;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function budgetMicros(record: SessionRecord) {
  const exact = record.budget?.max_cost_micros;
  if (typeof exact === "string" && /^\d+$/.test(exact)) {
    const value = BigInt(exact);
    if (value > 0n) return value;
  }

  const legacy = record.budget?.max_cost_usd;
  if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0) {
    return usdToMicros(String(legacy));
  }
  return undefined;
}

/**
 * Postgres Data Plane adapter adds hot-path invariants that are intentionally stricter
 * than generic accounting storage: billed usage must have an explicit customer price,
 * and an operational Reservation TTL must be renewable without becoming a hidden
 * Session lifetime limit.
 */
export class PostgresDataPlaneBillingStore extends PostgresBillingStore {
  private readonly reservationRenewalTtlSeconds: number;

  constructor(connectionString: string, options: { reservationRenewalTtlSeconds?: number } = {}) {
    super(connectionString);
    this.reservationRenewalTtlSeconds = positiveInteger(
      options.reservationRenewalTtlSeconds ?? 86_400,
      "reservationRenewalTtlSeconds",
    );
  }

  private async assertCustomerPricing(sessionId: string) {
    const result = await this.pool.query(
      `SELECT ue.id
       FROM gateway_usage_events ue
       LEFT JOIN gateway_usage_settlements us ON us.usage_event_id=ue.id
       LEFT JOIN gateway_ledger_entries le
         ON le.usage_event_id=ue.id AND le.book='customer'
       WHERE ue.session_id=$1
         AND (us.usage_event_id IS NULL OR us.state='no_price' OR le.id IS NULL)
       ORDER BY ue.measured_at, ue.created_at
       LIMIT 1`,
      [sessionId],
    );
    if (result.rows[0]) {
      throw new BillingPricingUnavailableError(sessionId, String(result.rows[0].id));
    }
  }

  private async renewReservationIfNeeded(sessionId: string) {
    await this.withTransaction(async (client) => {
      const identity = await client.query(
        `SELECT tenant_id FROM gateway_reservations WHERE session_id=$1 LIMIT 1`,
        [sessionId],
      );
      if (!identity.rows[0]) return;
      const tenantId = String(identity.rows[0].tenant_id);

      const exposureResult = await client.query(
        `SELECT
           a.credit_limit_micros,
           a.enabled,
           COALESCE((
             SELECT SUM(CASE WHEN direction='credit' THEN amount_micros ELSE -amount_micros END)
             FROM gateway_ledger_entries le
             WHERE le.book='customer' AND le.tenant_id=a.tenant_id
           ),0)::bigint AS ledger_balance_micros,
           COALESCE((
             SELECT SUM(GREATEST(0,amount_micros-consumed_micros))
             FROM gateway_reservations r
             WHERE r.tenant_id=a.tenant_id AND r.state='active' AND r.expires_at > now()
           ),0)::bigint AS reserved_micros
         FROM gateway_billing_accounts a
         WHERE a.tenant_id=$1
         FOR UPDATE`,
        [tenantId],
      );
      const exposure = exposureResult.rows[0];
      if (!exposure) throw new Error(`Billing account not found: ${tenantId}`);
      if (!exposure.enabled) throw new Error(`Billing account disabled: ${tenantId}`);

      const reservationResult = await client.query(
        `SELECT id,amount_micros,consumed_micros,state,expires_at
         FROM gateway_reservations
         WHERE session_id=$1
         LIMIT 1
         FOR UPDATE`,
        [sessionId],
      );
      const reservation = reservationResult.rows[0];
      if (!reservation || reservation.state !== "active") return;

      const remaining = BigInt(reservation.amount_micros) - BigInt(reservation.consumed_micros);
      if (remaining <= 0n) return;

      const expired = new Date(reservation.expires_at).getTime() <= Date.now();
      if (expired) {
        const available = BigInt(exposure.credit_limit_micros)
          + BigInt(exposure.ledger_balance_micros)
          - BigInt(exposure.reserved_micros);
        if (available < remaining) {
          throw new BillingInsufficientFundsError(available, remaining);
        }
      }

      await client.query(
        `UPDATE gateway_reservations
         SET expires_at=$2,updated_at=now()
         WHERE id=$1 AND state='active'`,
        [
          reservation.id,
          new Date(Date.now() + this.reservationRenewalTtlSeconds * 1000).toISOString(),
        ],
      );
    });
  }

  override async assertSessionBudget(sessionId: string) {
    await this.assertCustomerPricing(sessionId);
    await this.renewReservationIfNeeded(sessionId);
    return super.assertSessionBudget(sessionId);
  }
}

/**
 * Billing is injected at the SessionStore boundary because AgentGateway persists the
 * `creating` Session before it contacts the upstream provider. This lets the gateway
 * reserve customer capacity before any provider work without coupling core routing to
 * a particular billing implementation.
 */
export class BillingSessionStore implements SessionStore {
  private readonly reservationTtlSeconds: number;
  private readonly requireBudgetForBilledTenant: boolean;

  constructor(
    private readonly base: SessionStore,
    private readonly billing: BillingRuntimeStore,
    options: BillingSessionStoreOptions = {},
  ) {
    this.reservationTtlSeconds = positiveInteger(
      options.reservationTtlSeconds ?? 86_400,
      "reservationTtlSeconds",
    );
    this.requireBudgetForBilledTenant = options.requireBudgetForBilledTenant ?? true;
  }

  async create(record: SessionRecord) {
    await this.base.create(record);

    const account = await this.billing.getAccount(record.tenantId);
    if (!account) return;

    let reservation: ReservationRecord | undefined;
    try {
      if (!account.enabled) throw new Error(`Billing account disabled: ${record.tenantId}`);

      const requestedMicros = budgetMicros(record);
      if (!requestedMicros) {
        if (this.requireBudgetForBilledTenant) throw new SessionBudgetRequiredError(record.tenantId);
        return;
      }

      reservation = await this.billing.reserve({
        tenantId: record.tenantId,
        projectId: record.projectId,
        requestRef: `session:${record.id}`,
        amountMicros: requestedMicros,
        expiresAt: reservationExpiry(record, this.reservationTtlSeconds),
      });
      await this.billing.attachReservation(reservation.id, record.id);
    } catch (error) {
      // This catch runs entirely before AgentGateway invokes the provider, so releasing
      // the just-created reservation is safe. Once provider invocation begins, generic
      // SessionStore.update failures must never release the hold because the upstream
      // side effect may already exist.
      if (reservation) {
        await this.billing.releaseReservation(reservation.id).catch(() => undefined);
      }
      try {
        await this.base.update({
          ...record,
          state: "failed",
          lastError: errorMessage(error),
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // Preserve the original admission error. The durable store remains authoritative.
      }
      throw error;
    }
  }

  get(id: string) {
    return this.base.get(id);
  }

  async update(record: SessionRecord) {
    // Do not infer financial safety from a generic failed binding state. The provider
    // may have created a Session before local persistence failed. Reservations are
    // released only by the pre-provider admission path above or explicit reconciliation.
    await this.base.update(record);
  }
}

export interface DataPlaneBillingOptions {
  modelHint?: string;
  sourceRef?: string;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function inferSessionModel(session: GatewaySession, fallback?: string) {
  const direct = stringField((session as Record<string, unknown>).model);
  if (direct) return direct;

  const agent = (session as Record<string, unknown>).agent;
  if (agent && typeof agent === "object" && !Array.isArray(agent)) {
    const model = stringField((agent as Record<string, unknown>).model);
    if (model) return model;
  }
  return fallback;
}

export function sessionMeasuredAt(session: GatewaySession) {
  if (typeof session.last_active_at === "number" && Number.isFinite(session.last_active_at)) {
    return new Date(session.last_active_at * 1000).toISOString();
  }
  const rawUpdated = (session as Record<string, unknown>).updated_at;
  if (typeof rawUpdated === "number" && Number.isFinite(rawUpdated)) {
    return new Date(rawUpdated * 1000).toISOString();
  }
  if (typeof rawUpdated === "string" && Number.isFinite(new Date(rawUpdated).getTime())) {
    return new Date(rawUpdated).toISOString();
  }
  return new Date().toISOString();
}

export class DataPlaneBilling {
  constructor(private readonly billing: BillingRuntimeStore) {}

  async assertSessionBudget(sessionId: string) {
    return this.billing.assertSessionBudget(sessionId);
  }

  async observeSession(
    session: GatewaySession,
    context: GatewayRequestContext,
    options: DataPlaneBillingOptions = {},
  ) {
    if (!session.usage || typeof session.usage !== "object") {
      return { observationId: undefined, events: [], ledger: [] };
    }
    return this.billing.observeUsage({
      tenantId: context.tenantId,
      projectId: context.projectId,
      sessionId: session.id,
      providerType: session.gateway.provider,
      channelId: session.gateway.channel,
      model: inferSessionModel(session, options.modelHint),
      usage: session.usage,
      measuredAt: sessionMeasuredAt(session),
      sourceRef: options.sourceRef ?? `provider-session:${session.id}`,
    });
  }
}

export {
  BillingInsufficientFundsError,
  SessionBudgetExceededError,
  usdToMicros,
};
