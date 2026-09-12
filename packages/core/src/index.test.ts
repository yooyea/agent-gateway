import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryIdempotencyStore,
  StaticVirtualKeyAuthenticator,
  stableRequestHash,
} from "./index.js";

test("stableRequestHash ignores object key order", () => {
  assert.equal(stableRequestHash({ a: 1, b: { c: 2, d: 3 } }), stableRequestHash({ b: { d: 3, c: 2 }, a: 1 }));
});

test("static virtual key authentication returns tenant context", () => {
  const auth = new StaticVirtualKeyAuthenticator([
    { id: "vk_1", key: "ag_test", tenantId: "tenant_1", projectId: "project_1", enabled: true },
  ]);
  assert.deepEqual(auth.authenticate("Bearer ag_test"), {
    tenantId: "tenant_1",
    projectId: "project_1",
    virtualKeyId: "vk_1",
  });
});

test("idempotency replays completed responses and rejects changed payloads", async () => {
  const store = new InMemoryIdempotencyStore();
  const base = {
    tenantId: "tenant_1",
    virtualKeyId: "vk_1",
    scope: "agents.sessions.create",
    key: "request-1",
    requestHash: stableRequestHash({ input: "hello" }),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  assert.deepEqual(await store.claim(base), { state: "claimed" });
  assert.deepEqual(await store.claim(base), { state: "in_progress" });
  await store.complete({
    tenantId: base.tenantId,
    virtualKeyId: base.virtualKeyId,
    scope: base.scope,
    key: base.key,
    responseStatus: 201,
    responseBody: { id: "agsess_1" },
  });
  assert.deepEqual(await store.claim(base), {
    state: "replay",
    responseStatus: 201,
    responseBody: { id: "agsess_1" },
  });
  assert.deepEqual(await store.claim({ ...base, requestHash: stableRequestHash({ input: "changed" }) }), {
    state: "conflict",
  });
});
