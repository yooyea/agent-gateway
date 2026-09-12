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
| Channel Pool / Failover     |
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

A model gateway primarily routes requests and meters tokens. An agent gateway must additionally preserve durable execution state:

- sessions and turns
- runtime environments and sandboxes
- tools and MCP
- approvals and required actions
- artifacts and files
- subagents
- cancellation and event streams
- long-running execution
- per-session budgets
- provider/session affinity
- cost reservation and later reconciliation

A live session cannot be freely moved between credentials or providers without explicit migration semantics. That makes **Session + Execution + Billing** the core architecture triangle.

## Repository layout

```text
apps/server                       Data plane + bootstrap control plane
packages/protocol                 Provider plugin contract and shared types
packages/core                     Routing, session affinity, auth + idempotency contracts
packages/storage-postgres         Durable SaaS identity/session/idempotency store
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
docs/provider-plugin.md           Provider/channel plugin contract
```

## Current implementation

The current foundation contains:

- OpenAI Agents API-shaped data plane: `/agents/sessions`
- Postgres-backed Tenant / Project / Virtual Key persistence
- Virtual Key secrets hashed with SHA-256 at rest; plaintext is returned only at creation time
- Postgres-backed Session Directory with gateway-owned stable `agsess_*` IDs
- Session binding lifecycle: `creating -> bound | failed`
- strict session affinity to the originally selected Channel
- persisted `Idempotency-Key` handling for session creation with request fingerprints and replay
- Redis fixed-window rate limiting per Virtual Key
- Redis concurrency leases with heartbeat renewal and crash-safe TTL expiry
- Redis read-through/write-through hot Session cache with Postgres remaining authoritative
- Redis Channel circuit-breaker state for **new-session routing only**
- provider/channel separation and capability-aware routing
- OpenAI Agents API adapter
- event submission and event streaming
- provider plugin architecture
- real Postgres + Redis integration tests in CI

Billing ledger, persistent Channel configuration, encrypted upstream credentials, hard budget enforcement and RBAC remain subsequent implementation layers.

## Quick start with Postgres + Redis

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
```

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
    "agent": {"model":"gpt-6-astra","instructions":"Inspect the repository and fix the task."},
    "environment": {"type":"none"},
    "input":"Find the highest-impact issue and fix it."
  }'
```

Successful data-plane responses expose the current rate-limit envelope. A rejected request returns `429`, `Retry-After`, and `x-agent-gateway-limit-type` (`rate` or `concurrency`).

Retrying the same request with the same `Idempotency-Key` returns the original gateway session and adds:

```text
x-agent-gateway-idempotent-replay: true
```

An idempotent replay still counts against request rate limits but does **not** consume an upstream concurrency lease because it does not call the provider.

Force a provider or channel without changing the Agents API request body:

```bash
-H 'x-agent-gateway-provider: openai-agents'
-H 'x-agent-gateway-channel: openai-primary'
-H 'x-agent-gateway-max-cost-usd: 2.00'
```

List channels:

```bash
curl http://localhost:8787/api/gateway/channels \
  -H 'authorization: Bearer ag_dev_local'
```

The channel response includes `circuitOpen`. An open circuit excludes that Channel from **new Session** selection. Existing bound Sessions remain pinned to their original Channel and are never transparently migrated.

## Bootstrap Control Plane

Create a tenant:

```bash
curl -X POST http://localhost:8787/api/gateway/admin/tenants \
  -H 'authorization: Bearer admin_dev_local' \
  -H 'content-type: application/json' \
  -d '{"name":"Acme"}'
```

Create a project, then create a virtual key with the returned tenant/project IDs:

```text
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

A generated Virtual Key secret is returned once. Only its hash and display prefix are persisted.

## Local process without infrastructure

For a lightweight development process you may unset both durable and runtime services:

```bash
cp .env.example .env
unset DATABASE_URL
unset REDIS_URL
npm install
npm run build
npm start
```

This uses in-memory Session/Idempotency stores and `AGENT_GATEWAY_KEYS`; Redis-backed admission, cache and circuit state are disabled. Production requires both `DATABASE_URL` and `REDIS_URL`.

## Design rule: durable truth vs operational state

Postgres is authoritative for tenant identity, Virtual Keys, Session Bindings and idempotency. Redis contains only reconstructable or lease-based operational state:

```text
Postgres: durable truth
Redis:    hot cache / rate window / concurrency lease / circuit state
```

Redis loss must never erase a Session Binding or financial truth. Redis cache failures fall back to the durable SessionStore. Rate/concurrency Redis failures fail the data-plane request rather than silently allowing unbounded upstream spend.

## Design rule: compatibility outside, governance inside

The data plane follows the upstream Agents API shape as closely as practical. Gateway-specific routing and policy are carried through headers so ordinary clients do not need a gateway-specific request schema.

The control plane is separate under `/api/gateway/*` and owns tenants, projects, keys, channels, pricing, budgets, usage, billing, audit and administration.

## Roadmap

The implementation order is intentionally infrastructure-first:

1. persistent Provider/Channel configuration and encrypted credential storage
2. RBAC + operator audit for the Control Plane
3. usage meter + immutable billing ledger
4. session budget reservation and hard-stop policy
5. provider cost reconciliation and richer health scoring
6. full admin/dashboard APIs
7. additional provider adapters
8. explicit cross-provider migration instead of pretending sessions are stateless

See the documents in `docs/` for the normative design.
