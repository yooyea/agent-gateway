import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapActor, PostgresControlPlaneSecurity } from "@agent-gateway/control-plane-auth";
import { PostgresCommercialStore } from "@agent-gateway/commercial-postgres";
import { PostgresGatewayStore } from "@agent-gateway/storage-postgres";

const databaseUrl = process.env.DATABASE_URL;

test("commercial writes and success AuditEvent share the governed transaction", { skip: !databaseUrl }, async () => {
  const gateway = new PostgresGatewayStore(databaseUrl!);
  const commercial = new PostgresCommercialStore(databaseUrl!);
  const security = new PostgresControlPlaneSecurity(databaseUrl!);
  security.attachTransactionalPool(commercial.pool);

  await gateway.migrate();
  await security.migrate();
  await commercial.migrate();

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant_commercial_tx_${suffix}`;
  await gateway.createTenant({ id: tenantId, name: "Commercial transaction test" });
  const plan = await commercial.createPlan({ name: `Transaction plan ${suffix}` });
  const actor = bootstrapActor();

  await assert.rejects(
    security.withTransaction(async () => {
      const version = await commercial.createPlanVersion({
        planId: plan.id,
        billingInterval: "month",
        defaultSessionBudgetMicros: "1000000",
      });
      await security.appendAudit({
        id: `agaud_commercial_version_rollback_${suffix}`,
        actor,
        requestId: `req_commercial_version_rollback_${suffix}`,
        action: "commercial.plan_version.create",
        resourceType: "plan_version",
        resourceId: version.id,
        outcome: "success",
      });
      throw new Error("force commercial version rollback");
    }),
    /force commercial version rollback/,
  );
  assert.equal((await commercial.listPlanVersions(plan.id)).length, 0,
    "PlanVersion must roll back with its success audit");
  assert.equal((await security.listAudit({ resourceType: "plan_version" }))
    .some((event) => event.requestId === `req_commercial_version_rollback_${suffix}`), false);

  let versionId = "";
  await security.withTransaction(async () => {
    const version = await commercial.createPlanVersion({
      planId: plan.id,
      billingInterval: "month",
      defaultSessionBudgetMicros: "1000000",
    });
    versionId = version.id;
    await security.appendAudit({
      id: `agaud_commercial_version_commit_${suffix}`,
      actor,
      requestId: `req_commercial_version_commit_${suffix}`,
      action: "commercial.plan_version.create",
      resourceType: "plan_version",
      resourceId: version.id,
      outcome: "success",
    });
  });
  assert.equal((await commercial.listPlanVersions(plan.id)).length, 1);

  await assert.rejects(
    security.withTransaction(async () => {
      const subscription = await commercial.createSubscription({ tenantId, planVersionId: versionId });
      await security.appendAudit({
        id: `agaud_commercial_sub_rollback_${suffix}`,
        actor,
        requestId: `req_commercial_sub_rollback_${suffix}`,
        action: "commercial.subscription.create",
        resourceType: "subscription",
        resourceId: subscription.id,
        tenantId,
        outcome: "success",
      });
      throw new Error("force commercial subscription rollback");
    }),
    /force commercial subscription rollback/,
  );
  assert.equal((await commercial.listSubscriptions(tenantId)).length, 0,
    "Subscription must roll back with its success audit");

  await security.close();
  await commercial.close();
  await gateway.close();
});
