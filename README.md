# Agent Gateway

**Agent Gateway is an open-source Agent API gateway and SaaS control plane.**

It sits between any product and one or more upstream agent runtimes. The caller should not need to know which upstream account, credential, channel, sandbox, or provider actually executes a session.

The mental model is similar to an LLM API gateway, but the unit of routing and billing is no longer a stateless model request. It is a stateful **agent session and execution lifecycle**.

```text
Any client / SaaS / IDE / CI
            |
      Virtual API Key
            |
            v
+-----------------------------+
|        Agent Gateway        |
|-----------------------------|
| Auth / Tenant / Project     |
| Session Router + Affinity   |
| Provider / Channel Registry |
| Rate / Concurrency / Circuit|
| Quota / Budget / Policy     |
| Usage / Billing / Ledger    |
| Audit / Trace / Metrics     |
+-------------+---------------+
              |
       Provider Channels
       /       |        \
 OpenAI     Claude*    Custom*
 Agents API Agent SDK  Harness
```

`*` is an architectural extension point, not necessarily an implemented provider.

## Product boundary

Agent Gateway is not tied to any upstream caller and not tied to any downstream provider.

A product only knows:

```text
AGENT_BASE_URL=https://gateway.example.com
AGENT_API_KEY=ag_xxx
```

The gateway owns provider credentials, channel selection, session affinity, policy enforcement, metering and settlement.

## Why an Agent Gateway is different from a Model Gateway

A model gateway primarily routes requests and meters tokens. An agent gateway must additionally preserve durable execution state: sessions and turns, sandboxes, tools/MCP, approvals, artifacts, subagents, cancellation/event streams, long-running execution, per-session budgets and provider/session affinity.

A live session cannot be freely moved between credentials or providers without explicit migration semantics. That makes **Session + Execution + Billing** the core architecture triangle.

## Repository layout

```text
apps/server                       Data plane + bootstrap control plane
packages/protocol                 Provider plugin contract and shared types
packages/core                     Routing, session affinity, auth + idempotency contracts
packages/credential-crypto        Provider Credential envelope encryption / keyring
packages/storage-postgres         Durable SaaS identity/runtime/session/idempotency store
packages/runtime-redis            Rate limit, concurrency, hot cache and circuit state
packages/provider-openai-agents   OpenAI Agents API adapter
packages/provider-mock            Local/test provider
packages/sdk                      Optional TypeScript client
docs/product-spec.md              Product specification
docs/architecture.md              System architecture
docs/ontology.md                  Domain ontology and invariants
docs/api-spec.md                  Northbound and management API contract
docs/billing.md                   Metering, reservation and settlement model
docs/persistence.md               Postgres schema and durability semantics
docs/runtime-controls.md          Redis runtime-state semantics
docs/credentials.md               Provider/Channel/Credential security and rotation
docs/provider-plugin.md           Provider/channel plugin contract
```

## Current implementation

`v0.3` establishes a durable, operable gateway foundation:

- OpenAI Agents API-shaped data plane: `/agents/sessions`
- Postgres-backed Tenant / Project / Virtual Key persistence
- Postgres-backed Provider / Channel configuration
- encrypted upstream Credential resources using AES-256-GCM
- credential master-key keyring and rewrap rotation flow
- trusted Provider type -> installed plugin mapping
- live runtime-registry rebuild after Provider / Credential / Channel mutations
- Virtual Key secrets hashed with SHA-256 at rest
- Postgres-backed Session Directory with stable `agsess_*` IDs
- Session binding lifecycle: `creating -> bound | failed`
- strict Session Affinity to the originally selected Channel
- persisted `Idempotency-Key` handling for session creation
- Redis request rate limiting per Virtual Key
- Redis concurrency leases with heartbeat renewal and crash-safe expiry
- Redis hot Session cache with Postgres remaining authoritative
- Redis Channel circuit-breaker state for **new-session routing only**
- OpenAI Agents API adapter and provider plugin architecture
- real Postgres + Redis integration tests in CI

The next major infrastructure layers are Control Plane RBAC/audit, Usage + immutable Ledger, and hard budget reservation/enforcement.

## Quick start

```bash
cp .env.example .env
docker compose up --build
```

The compose stack starts Postgres and Redis, runs schema bootstrap in development, and creates:

```text
Virtual Key:  ag_dev_local
Admin Token:  admin_dev_local
Tenant:       tenant_dev
Project:      project_dev
Channel:      mock-default
```

If `OPENAI_API_KEY` is present during development bootstrap, the gateway encrypts it into a Credential record and creates `openai-default`; it is not stored in Provider/Channel plaintext config.

Health:

```bash
curl http://localhost:8787/health
```

Create a session:

```bash
curl -X POST http://localhost:8787/agents/sessions \
  -H 'authorization: Bearer ag_dev_local' \
  -H 'idempotency-key: demo-create-1' \
  -H 'content-type: application/json' \
  -d '{
    "agent": {"instructions":"Inspect the repository and fix the task."},
    "environment": {"type":"none"},
    "input":"Find the highest-impact issue and fix it."
  }'
```

Successful data-plane responses expose the current rate-limit envelope. A rejected request returns `429`, `Retry-After`, and `x-agent-gateway-limit-type` (`rate` or `concurrency`).

An idempotent replay still counts against request-rate limits but does **not** consume upstream concurrency because no provider request is made.

Force a provider or channel without changing the Agents API body:

```bash
-H 'x-agent-gateway-provider: openai-agents'
-H 'x-agent-gateway-channel: openai-default'
-H 'x-agent-gateway-max-cost-usd: 2.00'
```

## Provider / Channel / Credential Control Plane

Bootstrap management routes are protected with `AGENT_GATEWAY_ADMIN_TOKEN`:

```text
GET/POST       /api/gateway/admin/providers
PATCH          /api/gateway/admin/providers/{id}
GET/POST       /api/gateway/admin/credentials
PATCH          /api/gateway/admin/credentials/{id}
POST           /api/gateway/admin/credentials/{id}/rewrap
GET/POST       /api/gateway/admin/channels
PATCH          /api/gateway/admin/channels/{id}
```

Provider and Channel config must contain only non-secret values. Secret-like config keys are rejected; upstream keys/tokens/passwords belong inside a Credential payload.

Credential payloads are encrypted before they enter Postgres. Master keys are supplied through:

```text
AGENT_GATEWAY_CREDENTIAL_KEYS
AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID
```

See `docs/credentials.md` for the full envelope and master-key rotation procedure.

## Session Affinity and channel lifecycle

An open circuit or a disabled Channel excludes it from **new Session** selection.

An existing `agsess_*` remains bound to its original Channel. Disabling a Channel, rotating its Credential, or rebuilding the registry does not silently move an existing Session to another Channel.

## Local process without infrastructure

For a lightweight development process:

```bash
unset DATABASE_URL
unset REDIS_URL
npm install
npm run build
npm start
```

This uses in-memory Session/Idempotency stores and `AGENT_GATEWAY_KEYS`, plus the legacy file/env Channel configuration path. Production requires durable persistence, Redis runtime controls and explicit Credential encryption keys.

## Durable truth vs operational state

```text
Postgres: tenants / keys / providers / credentials / channels / session bindings / idempotency
Redis:    hot cache / rate window / concurrency lease / circuit state
Env/KMS:  credential master encryption keys
```

Redis loss must never erase Session affinity or financial truth. Master encryption keys must never be stored in Postgres.

## Compatibility outside, governance inside

The Data Plane follows the upstream Agents API shape as closely as practical. Gateway-specific routing and policy use headers so callers do not need a gateway-specific agent protocol.

The Control Plane remains gateway-native and owns tenants, projects, keys, providers, credentials, channels, policies, pricing, budgets, usage, billing, audit and administration.

## Roadmap

1. Control Plane RBAC + immutable operator audit trail
2. usage meter + immutable billing ledger
3. session-budget reservation and hard-stop policy
4. provider cost reconciliation and richer health scoring
5. full admin/dashboard APIs
6. additional provider adapters
7. explicit cross-provider migration with lineage

See `docs/` for the normative design.
