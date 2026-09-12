import assert from "node:assert/strict";
import test from "node:test";
import { PostgresGatewayStore } from "@agent-gateway/storage-postgres";
import {
  BillingInsufficientFundsError,
  PostgresBillingStore,
  microsToUsdString,
  normalizeUsageSnapshot,
  usdToMicros,
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;

function canonicalDecimal(value: string | undefined) {
  if (!value) return value;
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

test("money conversion and usage normalization are deterministic", () => {
  assert.equal(usdToMicros("2.75"), 2_750_000n);
  assert.equal(microsToUsdString(2_750_000n), "2.75");
  assert.deepEqual(normalizeUsageSnapshot({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 25 },
    output_tokens: 50,
  }), [
    { metric: "model.input_tokens", quantity: "100" },
    { metric: "model.cached_input_tokens", quantity: "25" },
    { metric: "model.output_tokens", quantity: "50" },
  ]);
});

test("billing reservations, cumulative usage deltas and immutable financial history", { skip: !databaseUrl }, async () => {
  const gateway = new PostgresGatewayStore(databaseUrl!);
  const billing = new PostgresBillingStore(databaseUrl!);
  await gateway.migrate();
  await billing.migrate();

  const suffix = Math.random().toString(16).slice(2);
  const tenantId = `tenant_bill_${suffix}`;
  const projectId = `project_bill_${suffix}`;
  const sessionId = `agsess_bill_${suffix}`;

  await gateway.createTenant({ id: tenantId, name: "Billing test tenant" });
  await gateway.createProject({ id: projectId, tenantId, name: "Billing test project" });
  await gateway.create({
    id: sessionId,
    tenantId,
    projectId,
    provider: "openai-agents",
    channelId: "billing-test-channel",
    providerSessionId: `provider_${suffix}`,
    state: "bound",
    budget: { max_cost_usd: 4 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await billing.upsertAccount({ tenantId, creditLimitMicros: 5_000_000n });
  await billing.grantCredit({ tenantId, amountMicros: 1_000_000n, idempotencyKey: `credit:${suffix}` });
  assert.equal(await billing.getAvailableMicros(tenantId), 6_000_000n);

  const competing = await Promise.allSettled([
    billing.reserve({
      tenantId,
      projectId,
      requestRef: `concurrent-a:${suffix}`,
      amountMicros: 4_000_000n,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    billing.reserve({
      tenantId,
      projectId,
      requestRef: `concurrent-b:${suffix}`,
      amountMicros: 4_000_000n,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ]);
  assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
  const admitted = competing.find((result): result is PromiseFulfilledResult<any> => result.status === "fulfilled")!.value;
  const rejected = competing.find((result): result is PromiseRejectedResult => result.status === "rejected")!;
  assert(rejected.reason instanceof BillingInsufficientFundsError);
  await billing.releaseReservation(admitted.id);

  const reservation = await billing.reserve({
    tenantId,
    projectId,
    requestRef: `create:${suffix}`,
    amountMicros: 4_000_000n,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await billing.attachReservation(reservation.id, sessionId);
  assert.equal(await billing.getAvailableMicros(tenantId), 2_000_000n);

  const measuredAt = new Date();
  const price = await billing.createPriceRule({
    tenantId,
    providerType: "openai-agents",
    model: "gpt-test",
    metric: "model.input_tokens",
    unitScale: 1_000_000n,
    upstreamPriceMicros: 1_000_000n,
    customerPriceMicros: 2_000_000n,
    effectiveFrom: new Date(Date.now() - 10_000).toISOString(),
  });

  const first = await billing.observeUsage({
    tenantId,
    projectId,
    sessionId,
    providerType: "openai-agents",
    channelId: "billing-test-channel",
    model: "gpt-test",
    usage: { input_tokens: 500_000 },
    measuredAt: measuredAt.toISOString(),
    sourceRef: `provider-snapshot:${suffix}:1`,
  });
  assert.equal(first.events.length, 1);
  assert.equal(canonicalDecimal(first.events[0]?.quantity), "500000");
  assert.equal(first.events[0]?.settlementState, "settled");
  assert.equal(first.ledger.length, 2);
  const customerCharge = first.ledger.find((entry) => entry.book === "customer")!;
  assert.equal(customerCharge.direction, "debit");
  assert.equal(customerCharge.amountMicros, "1000000");
  assert.equal(customerCharge.priceSnapshot.rule_id, price.id);

  const afterFirst = await billing.getSessionReservation(sessionId);
  assert.equal(afterFirst?.consumedMicros, "1000000");
  assert.equal(await billing.getAvailableMicros(tenantId), 2_000_000n);

  const repeated = await billing.observeUsage({
    tenantId,
    projectId,
    sessionId,
    providerType: "openai-agents",
    channelId: "billing-test-channel",
    model: "gpt-test",
    usage: { input_tokens: 500_000 },
    measuredAt: new Date(measuredAt.getTime() + 1000).toISOString(),
    sourceRef: `provider-snapshot:${suffix}:2`,
  });
  assert.equal(repeated.events.length, 0);
  assert.equal(repeated.ledger.length, 0);

  const corrected = await billing.observeUsage({
    tenantId,
    projectId,
    sessionId,
    providerType: "openai-agents",
    channelId: "billing-test-channel",
    model: "gpt-test",
    usage: { input_tokens: 400_000 },
    measuredAt: new Date(measuredAt.getTime() + 2000).toISOString(),
    sourceRef: `provider-snapshot:${suffix}:3`,
  });
  assert.equal(canonicalDecimal(corrected.events[0]?.quantity), "-100000");
  assert.equal(corrected.events[0]?.finality, "adjustment");
  const refund = corrected.ledger.find((entry) => entry.book === "customer")!;
  assert.equal(refund.direction, "credit");
  assert.equal(refund.amountMicros, "200000");
  assert.equal((await billing.getSessionReservation(sessionId))?.consumedMicros, "800000");

  const stale = await billing.observeUsage({
    tenantId,
    projectId,
    sessionId,
    providerType: "openai-agents",
    channelId: "billing-test-channel",
    model: "gpt-test",
    usage: { input_tokens: 300_000 },
    measuredAt: new Date(measuredAt.getTime() + 1500).toISOString(),
    sourceRef: `provider-snapshot:${suffix}:stale`,
  });
  assert.equal(stale.events.length, 0);
  assert.equal(stale.ledger.length, 0);
  assert.equal((await billing.getSessionReservation(sessionId))?.consumedMicros, "800000");

  const concurrentSessionId = `agsess_bill_concurrent_${suffix}`;
  await gateway.create({
    id: concurrentSessionId,
    tenantId,
    projectId,
    provider: "openai-agents",
    channelId: "billing-test-channel",
    providerSessionId: `provider_concurrent_${suffix}`,
    state: "bound",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await Promise.all([
    billing.observeUsage({
      tenantId,
      projectId,
      sessionId: concurrentSessionId,
      providerType: "openai-agents",
      channelId: "billing-test-channel",
      model: "gpt-test",
      usage: { input_tokens: 100_000 },
      measuredAt: new Date(measuredAt.getTime() + 3000).toISOString(),
      sourceRef: `provider-snapshot:${suffix}:concurrent-a`,
    }),
    billing.observeUsage({
      tenantId,
      projectId,
      sessionId: concurrentSessionId,
      providerType: "openai-agents",
      channelId: "billing-test-channel",
      model: "gpt-test",
      usage: { input_tokens: 200_000 },
      measuredAt: new Date(measuredAt.getTime() + 4000).toISOString(),
      sourceRef: `provider-snapshot:${suffix}:concurrent-b`,
    }),
  ]);
  const concurrentCustomerLedger = await billing.listLedger({ sessionId: concurrentSessionId, book: "customer" });
  const concurrentNetMicros = concurrentCustomerLedger.reduce(
    (total, entry) => total + BigInt(entry.amountMicros) * (entry.direction === "debit" ? 1n : -1n),
    0n,
  );
  assert.equal(concurrentNetMicros, 400_000n);

  await billing.createPriceRule({
    tenantId,
    providerType: "openai-agents",
    model: "gpt-test",
    metric: "model.input_tokens",
    unitScale: 1_000_000n,
    customerPriceMicros: 9_000_000n,
    effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
  });
  const historical = (await billing.listLedger({ sessionId, book: "customer" }))
    .find((entry) => entry.id === customerCharge.id)!;
  assert.equal(historical.priceSnapshot.rule_id, price.id);
  assert.equal(historical.priceSnapshot.unit_price_micros, "2000000");

  await assert.rejects(
    billing.pool.query("UPDATE gateway_ledger_entries SET kind='tampered' WHERE id=$1", [customerCharge.id]),
    /append-only/,
  );
  await assert.rejects(
    billing.pool.query("DELETE FROM gateway_ledger_entries WHERE id=$1", [customerCharge.id]),
    /append-only/,
  );
  await assert.rejects(
    billing.pool.query("UPDATE gateway_usage_events SET quantity=1 WHERE id=$1", [first.events[0]!.id]),
    /append-only/,
  );
  await assert.rejects(
    billing.pool.query("DELETE FROM gateway_usage_events WHERE id=$1", [first.events[0]!.id]),
    /append-only/,
  );

  const persistedUsage = await billing.listUsage({ sessionId });
  assert.equal(persistedUsage.find((event) => event.id === first.events[0]!.id)?.settlementState, "settled");
  assert.equal(persistedUsage.find((event) => event.id === first.events[0]!.id)?.settlementPriceRuleId, price.id);

  const budget = await billing.assertSessionBudget(sessionId);
  assert.equal(budget.limited, true);
  if (budget.limited) assert.equal(budget.remainingMicros, 3_200_000n);

  await billing.close();
  await gateway.close();
});
