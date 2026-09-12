import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { InMemorySessionStore, type SessionRecord } from "@agent-gateway/core";
import { RedisRuntimeControls } from "./index.js";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  test("Redis runtime integration requires REDIS_URL", { skip: true }, () => undefined);
} else {
  test("Redis runtime controls enforce rate, concurrency, cache and circuit state", async (t) => {
    const prefix = `agent-gateway-test:${randomUUID()}`;
    const runtime = await RedisRuntimeControls.connect(redisUrl, {
      keyPrefix: prefix,
      circuitFailureThreshold: 2,
      circuitFailureWindowSeconds: 60,
      circuitOpenSeconds: 30,
    });
    t.after(async () => runtime.close());

    assert.equal((await runtime.health()).ok, true);

    const rateKey = `tenant_1:vk_1:${randomUUID()}`;
    assert.equal((await runtime.checkRateLimit({ key: rateKey, limit: 2, windowSeconds: 30 })).allowed, true);
    assert.equal((await runtime.checkRateLimit({ key: rateKey, limit: 2, windowSeconds: 30 })).allowed, true);
    const deniedRate = await runtime.checkRateLimit({ key: rateKey, limit: 2, windowSeconds: 30 });
    assert.equal(deniedRate.allowed, false);
    assert.equal(deniedRate.remaining, 0);

    const concurrencyKey = `tenant_1:vk_1:${randomUUID()}`;
    const lease1 = await runtime.acquireConcurrency({ key: concurrencyKey, limit: 2, ttlSeconds: 30 });
    const lease2 = await runtime.acquireConcurrency({ key: concurrencyKey, limit: 2, ttlSeconds: 30 });
    assert.equal(lease1.acquired, true);
    assert.equal(lease2.acquired, true);
    const deniedConcurrency = await runtime.acquireConcurrency({ key: concurrencyKey, limit: 2, ttlSeconds: 30 });
    assert.equal(deniedConcurrency.acquired, false);
    if (lease1.acquired) await runtime.releaseConcurrency(lease1.lease);
    const lease3 = await runtime.acquireConcurrency({ key: concurrencyKey, limit: 2, ttlSeconds: 30 });
    assert.equal(lease3.acquired, true);
    if (lease2.acquired) await runtime.releaseConcurrency(lease2.lease);
    if (lease3.acquired) await runtime.releaseConcurrency(lease3.lease);

    const base = new InMemorySessionStore();
    const cached = runtime.createCachedSessionStore(base, 60);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: `agsess_${randomUUID().replaceAll("-", "")}`,
      tenantId: "tenant_1",
      projectId: "project_1",
      virtualKeyId: "vk_1",
      provider: "mock",
      channelId: "mock-default",
      providerSessionId: "provider-session-1",
      state: "bound",
      createdAt: now,
      updatedAt: now,
    };
    await cached.create(record);
    assert.deepEqual(await cached.get(record.id), record);
    record.updatedAt = new Date(Date.now() + 1000).toISOString();
    await cached.update(record);
    assert.deepEqual(await cached.get(record.id), record);

    const channel = `channel-${randomUUID()}`;
    assert.equal(await runtime.isChannelAvailable(channel), true);
    await runtime.recordChannelFailure(channel);
    assert.equal(await runtime.isChannelAvailable(channel), true);
    await runtime.recordChannelFailure(channel);
    assert.equal(await runtime.isChannelAvailable(channel), false);
    await runtime.recordChannelSuccess(channel);
    assert.equal(await runtime.isChannelAvailable(channel), true);
  });
}
