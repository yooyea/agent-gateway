import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRecord, SessionStore } from "@agent-gateway/core";
import type { GatewaySession } from "@agent-gateway/protocol";
import {
  BillingSessionStore,
  DataPlaneBilling,
  SessionBudgetRequiredError,
  type BillingRuntimeStore,
} from "./index.js";

class MemorySessionStore implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly calls: string[] = [];

  async create(record: SessionRecord) {
    this.calls.push(`create:${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }

  async get(id: string) {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async update(record: SessionRecord) {
    this.calls.push(`update:${record.id}:${record.state}`);
    this.records.set(record.id, structuredClone(record));
  }
}

class FakeBilling implements BillingRuntimeStore {
  account = {
    tenantId: "tenant_1",
    currency: "USD",
    creditLimitMicros: "10000000",
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  reservations = new Map<string, any>();
  calls: string[] = [];
  observed: any[] = [];

  async getAccount(tenantId: string) {
    this.calls.push(`account:${tenantId}`);
    return this.account;
  }

  async reserve(input: any) {
    this.calls.push(`reserve:${input.requestRef}:${input.amountMicros}`);
    const reservation = {
      id: "agres_1",
      tenantId: input.tenantId,
      projectId: input.projectId,
      requestRef: input.requestRef,
      amountMicros: String(input.amountMicros),
      consumedMicros: "0",
      currency: "USD",
      state: "active",
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  async attachReservation(reservationId: string, sessionId: string) {
    this.calls.push(`attach:${reservationId}:${sessionId}`);
    const reservation = this.reservations.get(reservationId);
    reservation.sessionId = sessionId;
    return reservation;
  }

  async releaseReservation(reservationId: string, state: "released" | "expired" = "released") {
    this.calls.push(`release:${reservationId}:${state}`);
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return undefined;
    reservation.state = state;
    return reservation;
  }

  async getSessionReservation(sessionId: string) {
    return [...this.reservations.values()].find((item) => item.sessionId === sessionId);
  }

  async assertSessionBudget(sessionId: string) {
    const reservation = await this.getSessionReservation(sessionId);
    if (!reservation) return { limited: false as const };
    return { limited: true as const, remainingMicros: BigInt(reservation.amountMicros), reservation };
  }

  async observeUsage(input: any) {
    this.observed.push(input);
    return { observationId: "agobs_1", events: [], ledger: [] };
  }
}

function sessionRecord(budget: SessionRecord["budget"] = { max_cost_usd: 2 }) : SessionRecord {
  const now = new Date().toISOString();
  return {
    id: "agsess_1",
    tenantId: "tenant_1",
    projectId: "project_1",
    virtualKeyId: "vk_1",
    provider: "fake",
    channelId: "channel_1",
    state: "creating",
    budget,
    createdAt: now,
    updatedAt: now,
  };
}

test("billing session store reserves before provider work and releases on failed binding", async () => {
  const base = new MemorySessionStore();
  const billing = new FakeBilling();
  const store = new BillingSessionStore(base, billing, { reservationTtlSeconds: 60 });
  const record = sessionRecord();

  await store.create(record);
  assert.deepEqual(base.calls, ["create:agsess_1"]);
  assert.deepEqual(billing.calls.slice(0, 3), [
    "account:tenant_1",
    "reserve:session:agsess_1:2000000",
    "attach:agres_1:agsess_1",
  ]);
  assert.equal((await billing.getSessionReservation(record.id))?.state, "active");

  await store.update({ ...record, state: "failed", lastError: "provider failed" });
  assert.equal((await billing.getSessionReservation(record.id))?.state, "released");
});

test("billed tenant without a hard session budget fails before provider work", async () => {
  const base = new MemorySessionStore();
  const billing = new FakeBilling();
  const store = new BillingSessionStore(base, billing);
  const record = sessionRecord(undefined);

  await assert.rejects(store.create(record), SessionBudgetRequiredError);
  assert.equal(base.records.get(record.id)?.state, "failed");
  assert.equal(billing.calls.some((call) => call.startsWith("reserve:")), false);
});

test("unbilled tenant preserves legacy session behavior", async () => {
  const base = new MemorySessionStore();
  const billing = new FakeBilling();
  billing.getAccount = async () => undefined;
  const store = new BillingSessionStore(base, billing);
  const record = sessionRecord(undefined);

  await store.create(record);
  assert.equal(base.records.get(record.id)?.state, "creating");
  assert.equal(billing.calls.some((call) => call.startsWith("reserve:")), false);
});

test("data plane billing normalizes gateway session context into usage observation", async () => {
  const billing = new FakeBilling();
  const runtime = new DataPlaneBilling(billing);
  const session: GatewaySession = {
    id: "agsess_1",
    object: "agent.session",
    status: "idle",
    created_at: 1_700_000_000,
    last_active_at: 1_700_000_100,
    usage: { input_tokens: 100, output_tokens: 20 },
    agent: { model: "gpt-test" },
    gateway: { provider: "openai-agents", channel: "channel_1" },
  };

  await runtime.observeSession(session, {
    tenantId: "tenant_1",
    projectId: "project_1",
    virtualKeyId: "vk_1",
  });

  assert.equal(billing.observed.length, 1);
  assert.deepEqual(billing.observed[0], {
    tenantId: "tenant_1",
    projectId: "project_1",
    sessionId: "agsess_1",
    providerType: "openai-agents",
    channelId: "channel_1",
    model: "gpt-test",
    usage: { input_tokens: 100, output_tokens: 20 },
    measuredAt: new Date(1_700_000_100 * 1000).toISOString(),
    sourceRef: "provider-session:agsess_1",
  });
});
