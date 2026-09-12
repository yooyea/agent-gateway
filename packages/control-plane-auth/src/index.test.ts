import assert from "node:assert/strict";
import test from "node:test";
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

test("Postgres RBAC and append-only audit trail", { skip: !databaseUrl }, async () => {
  const security = new PostgresControlPlaneSecurity(databaseUrl!);
  await security.migrate();
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

  await security.pool.query("DELETE FROM gateway_role_bindings WHERE principal_id=$1", [principalId]);
  await security.pool.query("DELETE FROM gateway_control_principals WHERE id=$1", [principalId]);
  await security.close();
});
