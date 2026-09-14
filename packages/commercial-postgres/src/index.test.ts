import assert from "node:assert/strict";
import test from "node:test";
import { PostgresGatewayStore } from "@agent-gateway/storage-postgres";
import { PostgresCommercialStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;

test("commercial plans pin immutable versions and resolve tenant runtime policy", { skip: !databaseUrl }, async () => {
  const gateway = new PostgresGatewayStore(databaseUrl!);
  const commercial = new PostgresCommercialStore(databaseUrl!);
  await gateway.migrate();
  await commercial.migrate();

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant_commercial_${suffix}`;
  await gateway.createTenant({ id: tenantId, name: "Commercial test" });

  const plan = await commercial.createPlan({ name: `Pro ${suffix}`, description: "Commercial integration test" });
  const version = await commercial.createPlanVersion({
    planId: plan.id,
    billingInterval: "month",
    recurringPriceMicros: "29000000",
    includedCreditMicros: "10000000",
    defaultSessionBudgetMicros: "2500000",
    requestsPerMinute: 240,
    maxConcurrency: 32,
    entitlements: { providers: ["openai-agents"], features: ["mcp", "sandbox"] },
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(version.version, 1);
  assert.equal(version.defaultSessionBudgetMicros, "2500000");

  await assert.rejects(
    commercial.pool.query(`UPDATE gateway_plan_versions SET included_credit_micros=999 WHERE id=$1`, [version.id]),
    /immutable/,
  );

  const subscription = await commercial.createSubscription({
    tenantId,
    planVersionId: version.id,
  });
  assert.equal(subscription.status, "active");

  const policy = await commercial.resolvePolicy(tenantId);
  assert.equal(policy?.planId, plan.id);
  assert.equal(policy?.planVersionId, version.id);
  assert.equal(policy?.defaultSessionBudgetMicros, "2500000");
  assert.equal(policy?.requestsPerMinute, 240);
  assert.equal(policy?.maxConcurrency, 32);
  assert.equal(policy?.includedCreditMicros, "10000000");
  assert.deepEqual(policy?.entitlements, { providers: ["openai-agents"], features: ["mcp", "sandbox"] });

  await assert.rejects(
    commercial.createSubscription({ tenantId, planVersionId: version.id }),
    /overlapping subscription/,
  );

  await commercial.cancelSubscription(subscription.id);
  assert.equal(await commercial.resolvePolicy(tenantId), undefined);

  const version2 = await commercial.createPlanVersion({
    planId: plan.id,
    billingInterval: "month",
    recurringPriceMicros: "39000000",
    defaultSessionBudgetMicros: "5000000",
    requestsPerMinute: 500,
    maxConcurrency: 64,
  });
  assert.equal(version2.version, 2);
  const second = await commercial.createSubscription({ tenantId, planVersionId: version2.id });
  assert.equal((await commercial.resolvePolicy(tenantId))?.planVersionId, version2.id);
  assert.equal(second.planVersionId, version2.id);

  await commercial.close();
  await gateway.close();
});
