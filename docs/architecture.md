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

A Channel owns or references credentials, endpoint/account identity, priority/weight, health, capacity constraints and cost metadata.

## 3. Session affinity and durable binding

A new request follows:

```text
Create Session
   |
Authenticate Virtual Key -> Tenant / Project
   |
Resolve policy and select eligible Channel
   |
Allocate gateway agsess_...
   |
Persist SessionBinding(state=creating, selected Channel)
   |
Create provider-native session
   |                         |
 success                    failure
   |                         |
Persist provider ID       Persist state=failed
state=bound               + last error
   |
Return agsess_...
```

The binding is conceptually:

```text
agsess_123
  -> tenant_1
  -> provider=openai-agents
  -> channel=openai-account-a
  -> provider_session_id=session_xyz
  -> state=bound
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

The current implementation establishes capability filtering plus priority/weight metadata. Production routing policy and channel health will later move into durable + Redis-backed services.

## 5. Data Plane

Responsibilities:

- authenticate hashed Virtual Keys
- derive Tenant/Project context
- enforce policy
- create gateway session IDs
- resolve durable Session Bindings
- proxy/map events
- stream events
- persist idempotency decisions
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

The bootstrap implementation exposes admin-token protected create endpoints for Tenant, Project and Virtual Key. Full RBAC replaces the bootstrap admin token later.

## 7. Persistence

### Postgres

Implemented source of truth now:

- tenants/projects
- virtual keys (hashed secret + prefix)
- session bindings and binding lifecycle
- idempotency records and replay response

Planned Postgres source of truth:

- users/RBAC
- providers/channels/credential references
- routing decisions
- usage events
- price snapshots
- reservations
- ledger entries
- audit logs

### Redis

Planned operational state for:

- rate limits
- concurrency leases
- hot session routing cache
- channel health/circuit breaker
- short-lived idempotency acceleration

Redis is never the financial or session-affinity source of truth.

## 8. Idempotency

Session creation uses `Idempotency-Key` scoped by Tenant + Virtual Key + operation. The request fingerprint includes the data-plane body and routing hints.

A completed request replays the original response. A reused key with a different fingerprint fails. A concurrent request for a pending key fails as in-progress rather than creating a second upstream session.

Session-event idempotency remains compatible with the provider body field `idempotency_key`.

## 9. Billing pipeline

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

## 10. Reliability

For new sessions, unhealthy channels can be skipped or circuit-broken.

For an existing session, channel failure must not cause transparent rerouting to another provider because provider-native session state would be lost. The gateway exposes the failed/degraded state and may later offer explicit migration/recovery.

The durable `creating/bound/failed` binding state makes partially completed creation observable instead of silently losing the selected route.

## 11. Security

- upstream provider credentials never reach callers
- durable Virtual Key secrets are SHA-256 hashed at rest
- plaintext Virtual Key is returned only once at creation
- all data-plane access resolves a Tenant context
- session IDs are Tenant-isolated
- credential access belongs to a narrow provider execution boundary
- logs must redact bearer tokens and provider secrets
- financial/admin operations require RBAC and audit entries
- development bootstrap credentials are forbidden as a production mechanism

## 12. Extensibility

Provider packages implement a small adapter interface. The core knows Channels and capabilities, not vendor SDKs.

A provider may expose native fields in its session payload. The gateway rewrites the public session ID and appends `gateway.provider/channel` metadata instead of flattening every provider into a lowest-common-denominator object.
