import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import {
  bootstrapActor,
  hasPermission,
  PostgresControlPlaneSecurity,
  requirePermission,
  hashControlPlaneToken,
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;

test("bootstrap actor has every permission", () => {
  const actor = bootstrapActor();
  assert.equal(hasPermission(actor, "rbac.manage"), true);
  assert.equal(hasPermission(actor, "credentials.rewrap"), true);
});

test("tenant-scoped viewer only applies inside its tenant", () => {
  const actor = {
    id: "p1",
    name: "viewer",
    kind: "principal" as const,
    bindings: [{
      id: "b1",
      principalId: "p1",
      role: "viewer" as const,
      scopeType: "tenant" as const,
      scopeId: "tenant-a",
      createdAt: new Date().toISOString(),
    }],
  };
  assert.equal(hasPermission(actor, "channels.read", "tenant-a"), true);
  assert.equal(hasPermission(actor, "channels.read", "tenant-b"), false);
  assert.throws(() => requirePermission(actor, "channels.write", "tenant-a"));
});

test("Postgres RBAC, control idempotency and atomic audit transaction", { skip: !databaseUrl }, async () => {
  const security = new PostgresControlPlaneSecurity(databaseUrl!);
  const external = new Pool({ connectionString: databaseUrl! });
  security.attachTransactionalPool(external);
  await security.migrate();
  await external.query(`CREATE TABLE IF NOT EXISTS gateway_control_tx_probe(id text PRIMARY KEY)`);

  const suffix = Math.random().toString(16).slice(2);
  const principalId = `agcp_${suffix}`;
  const secret = `agcp_test_${suffix}`;
  const bindingId = `agrb_${suffix}`;
  const auditId = `agaud_${suffix}`;

  await security.createPrincipal({
    id: principalId,
    name: "Operator",
    tokenHash: hashControlPlaneToken(secret),
    tokenPrefix: secret.slice(0, 12),
  });
  await security.createRoleBinding({
    id: bindingId,
    principalId,
    role: "operator",
    scopeType: "global",
  });

  const actor = await security.authenticateToken(secret);
  assert(actor);
  assert.equal(hasPermission(actor, "channels.write"), true);
  assert.equal(hasPermission(actor, "rbac.manage"), false);

  await security.appendAudit({
    id: auditId,
    actor,
    requestId: `req_${suffix}`,
    action: "channel.update",
    resourceType: "channel",
    resourceId: "agch_test",
    outcome: "success",
    metadata: { test: true },
  });
  const events = await security.listAudit({ actorId: principalId, limit: 10 });
  assert.equal(events.some((event) => event.id === auditId), true);

  await assert.rejects(
    security.pool.query("UPDATE gateway_audit_events SET outcome='error' WHERE id=$1", [auditId]),
    /append-only/,
  );
  await assert.rejects(
    security.pool.query("DELETE FROM gateway_audit_events WHERE id=$1", [auditId]),
    /append-only/,
  );

  const idem = {
    actorId: principalId,
    scope: "principal.create",
    key: `idem-${suffix}`,
    requestHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.deepEqual(await security.claimControlIdempotency(idem), { state: "claimed" });
  assert.deepEqual(await security.claimControlIdempotency(idem), { state: "in_progress" });
  await security.completeControlIdempotency({
    ...idem,
    responseStatus: 201,
    responseEnvelope: "encrypted-response",
  });
  assert.deepEqual(await security.claimControlIdempotency(idem), {
    state: "replay",
    responseStatus: 201,
    responseEnvelope: "encrypted-response",
  });
  assert.deepEqual(await security.claimControlIdempotency({ ...idem, requestHash: "b".repeat(64) }), {
    state: "conflict",
  });

  const rollbackProbe = `rollback_${suffix}`;
  const rollbackAudit = `agaud_rollback_${suffix}`;
  await assert.rejects(
    security.withTransaction(async () => {
      await external.query("INSERT INTO gateway_control_tx_probe(id) VALUES ($1)", [rollbackProbe]);
      await security.appendAudit({
        id: rollbackAudit,
        actor,
        requestId: `req_rollback_${suffix}`,
        action: "probe.create",
        resourceType: "probe",
        resourceId: rollbackProbe,
        outcome: "success",
      });
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.equal((await external.query("SELECT 1 FROM gateway_control_tx_probe WHERE id=$1", [rollbackProbe])).rowCount, 0);
  assert.equal((await security.listAudit({ resourceId: rollbackProbe })).length, 0);

  const commitProbe = `commit_${suffix}`;
  const commitAudit = `agaud_commit_${suffix}`;
  await security.withTransaction(async () => {
    await external.query("INSERT INTO gateway_control_tx_probe(id) VALUES ($1)", [commitProbe]);
    await security.appendAudit({
      id: commitAudit,
      actor,
      requestId: `req_commit_${suffix}`,
      action: "probe.create",
      resourceType: "probe",
      resourceId: commitProbe,
      outcome: "success",
    });
  });
  assert.equal((await external.query("SELECT 1 FROM gateway_control_tx_probe WHERE id=$1", [commitProbe])).rowCount, 1);
  assert.equal((await security.listAudit({ resourceId: commitProbe })).length, 1);

  await external.query("DELETE FROM gateway_control_tx_probe WHERE id=$1", [commitProbe]);
  await security.pool.query("DELETE FROM gateway_role_bindings WHERE principal_id=$1", [principalId]);
  await security.pool.query("DELETE FROM gateway_control_principals WHERE id=$1", [principalId]);
  await external.end();
  await security.close();
});
