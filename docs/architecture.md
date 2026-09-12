# Architecture

Agent Gateway is a product-neutral control plane between products and heterogeneous Agent APIs.

```text
LineHalo / DeepHarness / future products
                 |
          Agent Gateway API / SDK
                 |
      +----------+-----------+
      |                      |
 Capability Router      Session Directory
      |                      |
      +----------+-----------+
                 |
          Provider Registry
        /        |         \
 OpenAI      Claude*     Custom*
 Agents API  Agent API   Harness
```

`*` means adapter slot, not an implemented provider in v0.1.

## Principle: capability negotiation, not lowest common denominator

Every provider declares `supported`, `native`, and optional limits. A product declares the capabilities a task requires. Routing only selects a provider that satisfies them.

This preserves provider-specific power: one provider may support native durable sessions and sandbox; another may only support tools and streaming. The gateway may later add emulation, but must label emulated capabilities separately rather than pretending they are native.

## Canonical lifecycle

1. Product creates a gateway session.
2. Gateway selects a provider or honors an explicit provider.
3. Gateway records `{gatewaySessionId -> provider, providerSessionId}`.
4. Product submits input to the stable gateway session id.
5. Gateway maps canonical messages/events to provider-native events.
6. Provider-specific details remain available under `raw`/`vendor` escape hatches.

## Persistence

v0.1 keeps the session directory in memory to keep the protocol small. Production should replace it with Postgres/Redis and store idempotency keys, routing decisions, provider session ids, usage, audit events, and task metadata.

## Security boundary

Provider API keys belong to the gateway, not LineHalo browsers. Product clients authenticate to the gateway. Sandboxes, MCP credentials, secrets and approval policies are attached server-side.
