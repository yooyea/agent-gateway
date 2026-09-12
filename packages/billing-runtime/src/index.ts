import type { GatewayRequestContext, SessionRecord, SessionStore } from "@agent-gateway/core";
import type { GatewaySession } from "@agent-gateway/protocol";
import {
  BillingInsufficientFundsError,
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

      const maxCost = record.budget?.max_cost_usd;
      const hasBudget = typeof maxCost === "number" && Number.isFinite(maxCost) && maxCost > 0;
      if (!hasBudget) {
        if (this.requireBudgetForBilledTenant) throw new SessionBudgetRequiredError(record.tenantId);
        return;
      }

      reservation = await this.billing.reserve({
        tenantId: record.tenantId,
        projectId: record.projectId,
        requestRef: `session:${record.id}`,
        amountMicros: usdToMicros(String(maxCost)),
        expiresAt: reservationExpiry(record, this.reservationTtlSeconds),
      });
      await this.billing.attachReservation(reservation.id, record.id);
    } catch (error) {
      if (reservation) {
        await this.billing.releaseReservation(reservation.id).catch(() => undefined);
      }
      await this.base.update({
        ...record,
        state: "failed",
        lastError: errorMessage(error),
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      throw error;
    }
  }

  get(id: string) {
    return this.base.get(id);
  }

  async update(record: SessionRecord) {
    await this.base.update(record);
    if (record.state !== "failed") return;

    // Preserve the provider error if releasing the financial hold fails. An active
    // reservation remains bounded by expires_at and can be reconciled later.
    const reservation = await this.billing.getSessionReservation(record.id).catch(() => undefined);
    if (reservation?.state === "active") {
      await this.billing.releaseReservation(reservation.id).catch(() => undefined);
    }
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
};
