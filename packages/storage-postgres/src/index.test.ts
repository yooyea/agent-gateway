import assert from "node:assert/strict";
import test from "node:test";
import {
  hashVirtualKey,
  stableRequestHash,
  StoreBackedVirtualKeyAuthenticator,
  type SessionRecord,
} from "@agent-gateway/core";
import { PostgresGatewayStore } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;

test("postgres persistence closes identity, runtime configuration, session and idempotency loops", { skip: !databaseUrl }, async () => {
  const store = new PostgresGatewayStore(databaseUrl!);
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const tenantId = `tenant_test_${suffix}`;
  const projectId = `project_test_${suffix}`;
  const virtualKeyId = `vk_test_${suffix}`;
  const secret = `ag_test_${suffix}`;
  const sessionId = `agsess_test_${suffix}`;
  const providerId = `agprov_test_${suffix}`;
  const credentialId = `agcred_test_${suffix}`;
  const channelId = `agch_test_${suffix}`;

  try {
    await store.migrate();
    await store.createTenant({ id: tenantId, name: "Integration tenant" });
    await store.createProject({ id: projectId, tenantId, name: "Integration project" });
    await store.createVirtualKey({
      id: virtualKeyId,
      tenantId,
      projectId,
      name: "integration-key",
      keyHash: hashVirtualKey(secret),
      keyPrefix: secret.slice(0, 10),
    });

    const auth = new StoreBackedVirtualKeyAuthenticator(store);
    assert.deepEqual(await auth.authenticate(`Bearer ${secret}`), { tenantId, projectId, virtualKeyId });

    await store.createProvider({
      id: providerId,
      type: `mock-${suffix}`,
      displayName: "Integration provider",
      config: { region: "test" },
    });
    await store.createCredential({
      id: credentialId,
      providerId,
      name: "integration credential",
      kind: "api_key",
      encryptedPayload: `encrypted:${suffix}`,
      encryptionKeyId: "test-key",
      algorithm: "aes-256-gcm",
    });
    await store.createChannel({
      id: channelId,
      providerId,
      credentialId,
      name: "Integration channel",
      priority: 20,
      weight: 50,
      config: { baseUrl: "https://example.invalid" },
    });

    const runtime = await store.listRuntimeChannels();
    const runtimeChannel = runtime.find((item) => item.id === channelId);
    assert.equal(runtimeChannel?.providerId, providerId);
    assert.equal(runtimeChannel?.providerType, `mock-${suffix}`);
    assert.equal(runtimeChannel?.credential?.encryptedPayload, `encrypted:${suffix}`);
    assert.deepEqual(runtimeChannel?.providerConfig, { region: "test" });
    assert.deepEqual(runtimeChannel?.config, { baseUrl: "https://example.invalid" });

    const listedCredentials = await store.listCredentials();
    const redacted = listedCredentials.find((item) => item.id === credentialId) as Record<string, unknown> | undefined;
    assert.ok(redacted);
    assert.equal("encryptedPayload" in redacted!, false);

    const otherProviderId = `agprov_other_${suffix}`;
    await store.createProvider({ id: otherProviderId, type: `other-${suffix}`, displayName: "Other provider" });
    await assert.rejects(() => store.createChannel({
      id: `agch_wrong_${suffix}`,
      providerId: otherProviderId,
      credentialId,
      name: "Wrong credential provider",
    }));

    const now = new Date().toISOString();
    const creating: SessionRecord = {
      id: sessionId,
      tenantId,
      projectId,
      virtualKeyId,
      provider: `mock-${suffix}`,
      channelId,
      state: "creating",
      createdAt: now,
      updatedAt: now,
    };
    await store.create(creating);
    assert.equal((await store.get(sessionId))?.state, "creating");
    const bound: SessionRecord = {
      ...creating,
      state: "bound",
      providerSessionId: `provider_${suffix}`,
      updatedAt: new Date().toISOString(),
    };
    await store.update(bound);
    const persisted = await store.get(sessionId);
    assert.equal(persisted?.state, "bound");
    assert.equal(persisted?.providerSessionId, `provider_${suffix}`);
    assert.equal(persisted?.channelId, channelId);

    const requestHash = stableRequestHash({ input: "hello", channel: channelId });
    const claim = {
      tenantId,
      virtualKeyId,
      scope: "agents.sessions.create",
      key: `idem_${suffix}`,
      requestHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    assert.deepEqual(await store.claim(claim), { state: "claimed" });
    assert.deepEqual(await store.claim(claim), { state: "in_progress" });
    await store.complete({
      tenantId,
      virtualKeyId,
      scope: claim.scope,
      key: claim.key,
      responseStatus: 201,
      responseBody: { id: sessionId },
    });
    assert.deepEqual(await store.claim(claim), {
      state: "replay",
      responseStatus: 201,
      responseBody: { id: sessionId },
    });
    assert.deepEqual(
      await store.claim({ ...claim, requestHash: stableRequestHash({ input: "changed" }) }),
      { state: "conflict" },
    );
  } finally {
    await store.pool.query("DELETE FROM gateway_sessions WHERE tenant_id = $1", [tenantId]).catch(() => undefined);
    await store.pool.query("DELETE FROM gateway_channels WHERE id LIKE $1", [`%${suffix}`]).catch(() => undefined);
    await store.pool.query("DELETE FROM gateway_credentials WHERE id LIKE $1", [`%${suffix}`]).catch(() => undefined);
    await store.pool.query("DELETE FROM gateway_providers WHERE id LIKE $1", [`%${suffix}`]).catch(() => undefined);
    await store.pool.query("DELETE FROM gateway_tenants WHERE id = $1", [tenantId]).catch(() => undefined);
    await store.close();
  }
});
