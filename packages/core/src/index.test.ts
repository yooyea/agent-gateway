import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProvider, ProviderSession } from "@agent-gateway/protocol";
import {
  AgentGateway,
  InMemoryIdempotencyStore,
  ProviderRegistry,
  StaticVirtualKeyAuthenticator,
  stableRequestHash,
  type ChannelRuntimeState,
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

class FakeProvider implements AgentProvider {
  readonly type = "fake";
  readonly displayName: string;
  getCalls = 0;
  private sequence = 0;
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(readonly name: string) {
    this.displayName = name;
  }

  capabilities() {
    return { supported: ["durable_session" as const], native: ["durable_session" as const] };
  }

  async health() {
    return { ok: true };
  }

  async createSession() {
    const id = `${this.name}-${++this.sequence}`;
    const session: ProviderSession = {
      providerSessionId: id,
      status: "idle",
      createdAt: new Date().toISOString(),
      raw: { id, object: "agent.session" },
    };
    this.sessions.set(id, session);
    return session;
  }

  async getSession(id: string) {
    this.getCalls += 1;
    const session = this.sessions.get(id);
    if (!session) throw new Error("missing fake session");
    return session;
  }

  async sendEvents() {}
}

test("circuit breaker reroutes only new sessions and preserves existing session affinity", async () => {
  const unavailable = new Set<string>();
  const runtime: ChannelRuntimeState = {
    isChannelAvailable: async (channelId) => !unavailable.has(channelId),
    recordChannelSuccess: async () => undefined,
    recordChannelFailure: async () => undefined,
  };
  const primary = new FakeProvider("primary");
  const secondary = new FakeProvider("secondary");
  const registry = new ProviderRegistry()
    .register({ id: "channel-a", provider: primary, enabled: true, priority: 10, weight: 100 })
    .register({ id: "channel-b", provider: secondary, enabled: true, priority: 20, weight: 100 });
  const gateway = new AgentGateway(registry, undefined, "fake", runtime);
  const context = { tenantId: "tenant_1", virtualKeyId: "vk_1" };

  const first = await gateway.createSession({ agent: { model: "test" } }, context, { requiredCapabilities: ["durable_session"] });
  assert.equal(first.gateway.channel, "channel-a");

  unavailable.add("channel-a");
  await gateway.getSession(first.id, context);
  assert.equal(primary.getCalls, 1, "bound sessions must still resolve through their original channel");

  const second = await gateway.createSession({ agent: { model: "test" } }, context, { requiredCapabilities: ["durable_session"] });
  assert.equal(second.gateway.channel, "channel-b");
});
