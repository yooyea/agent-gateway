import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { PostgresBillingStore } from "@agent-gateway/billing-postgres";
import { bootstrapActor, PostgresControlPlaneSecurity, type ControlPlaneActor } from "@agent-gateway/control-plane-auth";
import { hasBillingPermission } from "@agent-gateway/control-plane-auth/billing";
import { CredentialKeyring } from "@agent-gateway/credential-crypto";
import { PostgresGatewayStore } from "@agent-gateway/storage-postgres";
import { createBillingControlPlaneHandler } from "./billing-control-plane.js";

const databaseUrl = process.env.DATABASE_URL;
const TEST_KEY = "YWdlbnQtZ2F0ZXdheS1kZXYta2V5LTMyLWJ5dGVzISE=";

function actor(role: "owner" | "admin" | "operator" | "viewer", scope: "global" | "tenant", scopeId?: string): ControlPlaneActor {
  return {
    id: `principal_${role}_${scope}_${scopeId ?? "all"}`,
    name: `${role}-${scope}`,
    kind: "principal",
    bindings: [{
      id: `binding_${role}_${scope}_${scopeId ?? "all"}`,
      principalId: `principal_${role}_${scope}_${scopeId ?? "all"}`,
      role,
      scopeType: scope,
      scopeId,
      createdAt: new Date().toISOString(),
    }],
  };
}

test("billing permissions keep monetary writes admin-only and honor Tenant scope", () => {
  const globalAdmin = actor("admin", "global");
  assert.equal(hasBillingPermission(globalAdmin, "billing.accounts.write", "tenant_a"), true);
  assert.equal(hasBillingPermission(globalAdmin, "billing.credits.write", "tenant_a"), true);
  assert.equal(hasBillingPermission(globalAdmin, "billing.pricing.write"), true);

  const globalOperator = actor("operator", "global");
  assert.equal(hasBillingPermission(globalOperator, "billing.ledger.read", "tenant_a"), true);
  assert.equal(hasBillingPermission(globalOperator, "billing.usage.read", "tenant_b"), true);
  assert.equal(hasBillingPermission(globalOperator, "billing.accounts.write", "tenant_a"), false);
  assert.equal(hasBillingPermission(globalOperator, "billing.credits.write", "tenant_a"), false);

  const tenantAdmin = actor("admin", "tenant", "tenant_a");
  assert.equal(hasBillingPermission(tenantAdmin, "billing.accounts.write", "tenant_a"), true);
  assert.equal(hasBillingPermission(tenantAdmin, "billing.accounts.write", "tenant_b"), false);
  assert.equal(hasBillingPermission(tenantAdmin, "billing.pricing.write", "tenant_a"), true);
  assert.equal(hasBillingPermission(tenantAdmin, "billing.pricing.write"), false,
    "global PriceRule mutation requires a global binding");

  const tenantViewer = actor("viewer", "tenant", "tenant_a");
  assert.equal(hasBillingPermission(tenantViewer, "billing.ledger.read", "tenant_a"), true);
  assert.equal(hasBillingPermission(tenantViewer, "billing.ledger.read", "tenant_b"), false);
  assert.equal(hasBillingPermission(tenantViewer, "billing.ledger.read"), false,
    "unfiltered cross-Tenant financial reads require a global binding");
});

test("billing mutation and success AuditEvent commit and roll back atomically", { skip: !databaseUrl }, async () => {
  const gateway = new PostgresGatewayStore(databaseUrl!);
  const billing = new PostgresBillingStore(databaseUrl!);
  const security = new PostgresControlPlaneSecurity(databaseUrl!);
  security.attachTransactionalPool(billing.pool);

  await gateway.migrate();
  await billing.migrate();
  await security.migrate();

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const rollbackTenant = `tenant_billing_rollback_${suffix}`;
  const commitTenant = `tenant_billing_commit_${suffix}`;
  await gateway.createTenant({ id: rollbackTenant, name: "Billing rollback" });
  await gateway.createTenant({ id: commitTenant, name: "Billing commit" });
  const controlActor = bootstrapActor();

  await assert.rejects(
    security.withTransaction(async () => {
      await billing.upsertAccount({
        tenantId: rollbackTenant,
        creditLimitMicros: 5_000_000n,
        enabled: true,
      });
      await security.appendAudit({
        id: `agaud_billing_rollback_${suffix}`,
        actor: controlActor,
        requestId: `req_billing_rollback_${suffix}`,
        action: "billing.account.upsert",
        resourceType: "billing_account",
        resourceId: rollbackTenant,
        tenantId: rollbackTenant,
        outcome: "success",
      });
      throw new Error("force billing rollback");
    }),
    /force billing rollback/,
  );

  assert.equal(await billing.getAccount(rollbackTenant), undefined);
  assert.equal((await security.listAudit({ resourceId: rollbackTenant })).length, 0,
    "a rolled-back financial mutation must not leave a success audit");

  await security.withTransaction(async () => {
    await billing.upsertAccount({
      tenantId: commitTenant,
      creditLimitMicros: 7_000_000n,
      enabled: true,
    });
    await security.appendAudit({
      id: `agaud_billing_commit_${suffix}`,
      actor: controlActor,
      requestId: `req_billing_commit_${suffix}`,
      action: "billing.account.upsert",
      resourceType: "billing_account",
      resourceId: commitTenant,
      tenantId: commitTenant,
      outcome: "success",
    });
  });

  const committed = await billing.getAccount(commitTenant);
  assert.equal(committed?.creditLimitMicros, "7000000");
  const audit = await security.listAudit({ resourceId: commitTenant });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.outcome, "success");
  assert.equal(audit[0]?.tenantId, commitTenant);

  await security.close();
  await billing.close();
  await gateway.close();
});

test("billing mutation idempotency-header rejection is audited", { skip: !databaseUrl }, async () => {
  const gateway = new PostgresGatewayStore(databaseUrl!);
  const billing = new PostgresBillingStore(databaseUrl!);
  const security = new PostgresControlPlaneSecurity(databaseUrl!);
  const keyring = new CredentialKeyring({ test: TEST_KEY }, "test");
  security.attachTransactionalPool(billing.pool);

  await gateway.migrate();
  await billing.migrate();
  await security.migrate();

  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant_billing_idem_audit_${suffix}`;
  await gateway.createTenant({ id: tenantId, name: "Billing idempotency audit" });

  const handler = createBillingControlPlaneHandler({
    billing,
    security,
    credentialKeyring: keyring,
    bootstrapToken: "billing-bootstrap-test",
    idempotencyPendingTtlSeconds: 60,
    idempotencyCompletedTtlSeconds: 600,
  });
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (!(await handler(req, res, path))) {
      res.writeHead(404).end();
    }
  });

  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/gateway/admin/billing/accounts/${tenantId}`, {
      method: "PUT",
      headers: {
        authorization: "Bearer billing-bootstrap-test",
        "content-type": "application/json",
        "x-request-id": `req_billing_idem_audit_${suffix}`,
      },
      body: JSON.stringify({ credit_limit_micros: "1000000", enabled: true }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Idempotency-Key is required/);
    assert.equal(await billing.getAccount(tenantId), undefined);

    const audit = await security.listAudit({ resourceId: tenantId });
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.outcome, "error");
    assert.equal(audit[0]?.action, "billing.account.upsert");
    assert.equal(audit[0]?.requestId, `req_billing_idem_audit_${suffix}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await security.close();
    await billing.close();
    await gateway.close();
  }
});
