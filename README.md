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
packages/provider-openai-agents   OpenAI Agents API adapter
packages/provider-mock            Local/test provider
packages/sdk                      Optional TypeScript client
docs/product-spec.md              Product specification
docs/architecture.md              System architecture
docs/ontology.md                  Domain ontology and invariants
docs/api-spec.md                  Northbound and management API contract
docs/billing.md                   Metering, reservation and settlement model
docs/persistence.md               Postgres schema and durability semantics
docs/provider-plugin.md           Provider/channel plugin contract
```

## Current implementation

`v0.2` now contains the first durable SaaS foundation:

- OpenAI Agents API-shaped data plane: `/agents/sessions`
- Postgres-backed Tenant / Project / Virtual Key persistence
- Virtual Key secrets hashed with SHA-256 at rest; plaintext is returned only at creation time
- Postgres-backed Session Directory with gateway-owned stable `agsess_*` IDs
- Session binding lifecycle: `creating -> bound | failed`
- strict session affinity to the originally selected Channel
- persisted `Idempotency-Key` handling for session creation with request fingerprints and replay
- provider/channel separation and capability-aware routing
- OpenAI Agents API adapter
- event submission and event streaming
- provider plugin architecture
- in-memory persistence remains available for lightweight local development when `DATABASE_URL` is absent

Billing ledger, Redis operational state, hard budget enforcement and RBAC remain subsequent implementation layers.

## Quick start with Postgres

```bash
cp .env.example .env
docker compose up --build
```

The compose stack starts Postgres, runs schema bootstrap in development, and creates:

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

Retrying the same request with the same `Idempotency-Key` returns the original gateway session and adds:

```text
x-agent-gateway-idempotent-replay: true
```

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

## Local process without Postgres

For a minimal development process:

```bash
cp .env.example .env
unset DATABASE_URL
npm install
npm run build
npm start
```

This uses the in-memory Session/Idempotency stores and `AGENT_GATEWAY_KEYS`.

## Design rule: compatibility outside, governance inside

The data plane follows the upstream Agents API shape as closely as practical. Gateway-specific routing and policy are carried through headers so ordinary clients do not need a gateway-specific request schema.

The control plane is separate under `/api/gateway/*` and owns tenants, projects, keys, channels, pricing, budgets, usage, billing, audit and administration.

## Roadmap

The implementation order is intentionally infrastructure-first:

1. Redis-backed concurrency/rate limiting and hot session cache
2. persistent provider/channel configuration and encrypted credential storage
3. RBAC + operator audit for the Control Plane
4. usage meter + immutable billing ledger
5. session budget reservation and hard-stop policy
6. provider cost reconciliation
7. channel health, circuit breaking and failover policy
8. full admin/dashboard APIs
9. additional provider adapters
10. explicit cross-provider migration instead of pretending sessions are stateless

See the documents in `docs/` for the normative design.
