# Architecture

## 1. System boundary

Agent Gateway is independent infrastructure between arbitrary callers and heterogeneous agent runtimes.

```text
                         CALLERS
          SaaS / IDE / CI / Internal Platform
                            |
                     Virtual API Key
                            |
                            v
+----------------------------------------------------------+
|                      DATA PLANE                          |
| Auth -> Policy -> Session Router -> Session Affinity     |
|              -> Provider Channel -> Agent Runtime        |
+----------------------------+-----------------------------+
                             |
                events / usage / traces
                             |
+----------------------------v-----------------------------+
|                    CONTROL PLANE                         |
| Tenants / Projects / Keys / RBAC                         |
| Providers / Channels / Credentials / Health              |
| Routing Policies / Quota / Rate / Concurrency            |
| Pricing / Reservation / Usage / Ledger / Reconciliation  |
| Audit / Metrics / Administration                         |
+----------------------------------------------------------+
```

The first implementation serves both planes from one Node process. The boundary is logical and must remain explicit so the planes can be split later.

## 2. Provider is not Channel

`Provider` describes a runtime implementation such as `openai-agents`.

`Channel` is one routable upstream configuration:

```text
Provider: openai-agents
  |- Channel: openai-account-a
  |- Channel: openai-account-b
  |- Channel: enterprise-openai-project-x
```

A Channel owns or references:

- credentials
- base endpoint
- account/project identity
- priority / weight
- health
- capacity/rate constraints
- cost/pricing metadata

This separation is required for real gateway behavior.

## 3. Session affinity

A new request follows:

```text
Create Session
   |
   v
Authenticate Virtual Key
   |
   v
Resolve Tenant/Project Policy
   |
   v
Select eligible Channel
   |
   v
Create provider-native session
   |
   v
Persist Session Binding
   |
   v
Return gateway-owned agsess_...
```

The binding is conceptually:

```text
agsess_123
  -> tenant_1
  -> provider=openai-agents
  -> channel=openai-account-a
  -> provider_session_id=session_xyz
```

Every later operation resolves the binding first:

```text
agsess_123 -> openai-account-a -> session_xyz
```

It must not be load-balanced again.

## 4. Routing

Routing only applies when a new session is created or when an explicit migration operation creates a replacement session.

Selection pipeline:

1. requested explicit channel, if any
2. provider constraint
3. tenant/project allow policy
4. required capabilities
5. enabled state
6. health/circuit-breaker state
7. capacity/rate/concurrency availability
8. priority tier
9. weighted selection inside the tier
10. optional cost/latency/reliability scoring

The current implementation establishes capability filtering plus priority/weight metadata. Production routing should move policy and health state into durable services.

## 5. Data Plane

Responsibilities:

- authenticate virtual keys
- derive tenant/project context
- enforce policy
- create gateway session IDs
- resolve session bindings
- proxy/map events
- stream events
- emit usage/trace records
- enforce active budget/concurrency decisions

It should avoid administrative joins or expensive analytics on the hot path.

## 6. Control Plane

Responsibilities:

- tenant/user/project lifecycle
- virtual-key lifecycle
- provider/channel/credential management
- price tables
- route policy
- quota/budget policy
- wallet/invoice configuration
- usage reconciliation
- audit and operator workflows

## 7. Persistence

### Postgres

Source of truth for:

- tenants/users/projects
- virtual keys (hashed secret material)
- providers/channels
- session bindings
- routing decisions
- idempotency records
- usage events
- price snapshots
- reservations
- ledger entries
- audit logs

### Redis

Operational state for:

- rate limits
- concurrency leases
- hot session routing cache
- channel health/circuit breaker
- short-lived idempotency acceleration

Redis is not the financial source of truth.

## 8. Billing pipeline

```text
Provider/runtime events
        |
        v
Raw Usage Capture
        |
        v
Normalization
        |
        v
Cost Estimation --------> Budget Guard
        |
        v
Provisional Settlement
        |
        v
Provider Reconciliation
        |
        v
Immutable Ledger
```

Provider session `usage` is evidence, not the ledger itself.

## 9. Reliability

For new sessions, unhealthy channels can be skipped or circuit-broken.

For an existing session, channel failure must not cause transparent rerouting to another provider because the provider-native session state would be lost. The gateway should instead expose a failed/degraded state and optionally offer an explicit migration/recovery operation.

## 10. Security

- upstream provider credentials never reach callers
- virtual-key secrets are hashed at rest in production
- all data-plane access resolves a tenant context
- session IDs are tenant-isolated
- credential access belongs to a narrow provider execution boundary
- logs must redact bearer tokens and provider secrets
- financial/admin operations require RBAC and audit entries

## 11. Extensibility

Provider packages implement a small adapter interface. The core knows channels and capabilities, not vendor SDKs.

A provider may expose native fields in its session payload. The gateway rewrites the public session ID and appends `gateway.provider/channel` metadata instead of flattening every provider into a lowest-common-denominator object.
