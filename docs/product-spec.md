# Agent Gateway Product Specification

## 1. Product definition

Agent Gateway is an open-source **Agent API gateway** with an optional SaaS control plane.

It gives callers one stable API key and one endpoint while hiding upstream agent-runtime accounts, credentials, routing, quotas and billing.

It is intentionally caller-neutral. A web product, IDE, CI worker, internal platform, mobile app or another gateway should all be ordinary clients.

## 2. Problem

Model API gateways already solve credential aggregation, virtual keys, rate limiting, routing, usage and billing for mostly stateless inference calls.

Agent runtimes introduce stateful execution:

- durable sessions
- long-running turns
- sandbox/environment lifecycle
- event streams
- tool and MCP calls
- approvals and required actions
- subagents
- artifacts/files
- execution cancellation
- provider usage that may change after an intermediate response

A model-request router is not enough. The gateway must understand the identity and lifecycle of an agent session.

## 3. Product promise

A client should be able to configure:

```text
AGENT_BASE_URL=https://gateway.example.com
AGENT_API_KEY=ag_xxx
```

and receive:

- stable Agent API access
- upstream credential abstraction
- routing and failover
- durable session affinity
- budget/quotas
- usage and cost visibility
- unified billing
- auditability

without knowing which upstream channel actually runs the session.

## 4. Primary users

### API consumer

Integrates one Agents API surface and does not manage provider credentials directly.

### Tenant administrator

Creates projects and virtual keys, configures quotas and views spend.

### Gateway operator

Configures provider channels, credentials, pricing, routing policy, health and settlement.

### Provider plugin developer

Adds a new agent runtime without modifying product callers or core routing logic.

## 5. Core capabilities

### 5.1 Identity and tenancy

- Tenant
- User / membership / RBAC
- Project
- Virtual Key
- key expiration/revocation
- IP or policy restrictions

### 5.2 Provider and channel management

- Provider type
- multiple Channels per Provider
- credential isolation
- priority and weight
- health state
- rate/concurrency capacity
- circuit breaker
- failover eligibility

### 5.3 Session runtime

- gateway-owned session ID
- channel binding / affinity
- provider session mapping
- create/retrieve/events/stream
- idempotency
- lifecycle state
- execution lineage
- explicit migration semantics

### 5.4 Policy

- allowed providers/channels/models
- required capabilities
- RPM/TPM where applicable
- concurrent sessions/executions
- daily/monthly spend
- per-session max cost
- max duration/iterations/subagents

### 5.5 Usage and billing

- raw provider usage
- normalized usage events
- upstream cost
- sell price
- reservation
- settlement
- reconciliation
- immutable ledger
- wallet/credit/invoice abstractions

### 5.6 Observability

- request/event trace
- session timeline
- channel/provider health
- usage and spend metrics
- audit log
- Prometheus/OpenTelemetry export

## 6. Data Plane

The Data Plane handles latency-sensitive agent traffic.

First compatibility target:

```text
POST /agents/sessions
GET  /agents/sessions/{id}
POST /agents/sessions/{id}/events
GET  /agents/sessions/{id}/events
```

Gateway-specific policy should not force a caller to learn a completely new agent request schema.

## 7. Control Plane

The Control Plane manages persistent configuration and commercial state.

Canonical resource groups:

```text
/api/gateway/tenants
/api/gateway/projects
/api/gateway/keys
/api/gateway/providers
/api/gateway/channels
/api/gateway/policies
/api/gateway/sessions
/api/gateway/usage
/api/gateway/pricing
/api/gateway/billing
/api/gateway/ledger
/api/gateway/audit
```

The implementation may be split into multiple services later without changing the domain boundary.

## 8. Routing semantics

A new session may be routed by:

- explicit channel
- explicit provider
- tenant/project policy
- required capability set
- health
- priority
- weight
- remaining capacity
- cost/latency/reliability policy

Once created, the selected Channel is persisted in a Session Binding.

Subsequent requests do not re-run ordinary load balancing.

## 9. Commercial model

The gateway supports two independent prices:

```text
upstream_cost = what the provider charges the gateway
customer_price = what the gateway charges the tenant
```

Customer price may be:

- pass-through
- fixed markup
- provider/model multiplier
- tool/sandbox markup
- subscription-included credits
- enterprise contracted rates

The ledger must store immutable monetary events rather than recomputing historical invoices from today's price table.

## 10. Budget semantics

A session may declare limits such as:

```json
{
  "max_cost_usd": 2.0,
  "max_duration_seconds": 1800,
  "max_iterations": 100,
  "max_subagents": 5
}
```

Budget is a policy, not merely a UI warning.

The platform should reserve spend capacity before allowing execution and release unused reservation when execution settles.

## 11. Non-goals

- pretending all providers have identical semantics
- silently converting unsupported provider features
- moving a live session across providers without an explicit migration operation
- embedding caller-product business logic in the gateway
- treating intermediate provider usage as immutable final billing truth

## 12. Delivery phases

The architecture is designed as a complete product; implementation can land incrementally.

The dependency order is:

1. correct session/channel identity model
2. durable persistence and idempotency
3. tenancy and virtual keys
4. quota/rate/concurrency
5. usage and immutable ledger
6. reservation and budget enforcement
7. reconciliation
8. operator/admin UX
9. provider expansion

Every phase must preserve the ontology and API invariants in the companion docs.
