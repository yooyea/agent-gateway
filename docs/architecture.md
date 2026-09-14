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
| Auth -> Policy -> Billing Admission -> Session Router    |
|      -> Session Affinity -> Provider Channel -> Runtime  |
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

## 2. Provider, Channel and Credential

`Provider` describes a runtime adapter implementation such as `openai-agents`.

`Channel` is one routable instance of a Provider. `Credential` contains encrypted provider authentication material and may be referenced only by Channels of the same Provider.

When Postgres is enabled, Provider/Channel/Credential records are the runtime source of truth. Database values cannot import arbitrary plugin modules; trusted module mapping is server/environment configuration.

Control-plane changes rebuild the in-memory ProviderRegistry. Stable Channel IDs preserve SessionBinding resolution across reloads.

## 3. Credential security boundary

Credential payloads are encrypted with AES-256-GCM before durable storage. Master keys never enter Postgres. Authenticated data binds ciphertext to Credential ID and Provider ID.

Multiple decrypt keys may coexist while one key is active for new encryption. Rotation keeps old keys available until Credentials and encrypted idempotency replay envelopes no longer require them.

## 4. Session affinity and financial admission

A new Session always selects and persists its Channel before provider creation:

```text
Authenticate Virtual Key -> Tenant / Project
        |
        v
select Channel
        |
        v
persist agsess_... / state=creating
```

For an unbilled Tenant, provider creation follows immediately.

For a billed Tenant, the SessionStore boundary inserts financial admission first:

```text
persist SessionBinding(state=creating)
        |
        v
resolve BillingAccount
        |
        v
require hard SessionBudget.max_cost_usd
        |
        v
reserve customer capacity
        |
        v
attach Reservation -> agsess_...
        |
        v
create provider-native session
```

If financial admission fails, no upstream Provider call is made. If provider creation fails, the Session becomes `failed` and its active Reservation is released best-effort.

Once a Session is bound, every later operation returns to the original Channel. Disabling a Channel or opening its circuit affects new routing only and never silently moves an existing Session.

## 5. Routing

Routing applies only to new Sessions or an explicit future migration.

Selection considers explicit Channel/Provider constraints, required capabilities, policy, health/circuit state, rate/concurrency/capacity, priority and weight. Financial policy may later influence ranking but must never violate caller Provider/capability constraints.

## 6. Data Plane

Responsibilities:

- authenticate hashed Virtual Keys
- derive Tenant/Project context
- enforce Project-level Session isolation for Project-scoped keys
- enforce rate/concurrency/policy
- create gateway Session IDs
- resolve durable SessionBindings
- reserve billed Session capacity before provider creation
- proxy/map events and streams
- persist idempotency decisions
- refresh and normalize provider usage
- settle usage into immutable LedgerEntries
- enforce active SessionBudget decisions before additional Agent work

The Data Plane should avoid administrative joins or analytics on the hot path. Financial hot-path queries are narrow admission/settlement operations over durable billing state.

## 7. Billing runtime boundary

`@agent-gateway/billing-runtime` is the lifecycle adapter between Agent execution and `@agent-gateway/billing-postgres`.

It deliberately does not own routing or pricing mathematics. It coordinates:

```text
SessionStore.create
    -> BillingAccount lookup
    -> Reservation admission
    -> attach Reservation

Session failure
    -> release active Reservation best-effort

GatewaySession usage
    -> normalize Data Plane attribution
    -> billing-postgres observeUsage

Expensive follow-up work
    -> refresh provider Session
    -> settle cumulative usage delta
    -> assert SessionBudget
```

The wrapping order is:

```text
Postgres SessionStore
        |
        v
BillingSessionStore
        |
        v
RedisCachedSessionStore
        |
        v
AgentGateway
```

Postgres remains durable truth; Redis only caches already-admitted Session state.

## 8. Follow-up work admission

For billed Session event submission or streaming:

```text
resolve Session + Project scope
        |
        v
acquire concurrency lease
        |
        v
GET provider Session snapshot
        |
        v
normalize cumulative usage
        |
        v
settle UsageEvent delta / Ledger
        |
        v
assert remaining SessionBudget
        |
        v
POST events or open stream
```

This preflight is fail-closed. If current financial state cannot be established, the gateway does not knowingly admit more Agent work.

After an upstream mutation has already succeeded, post-operation reconciliation is best-effort. Turning provider success into a client-visible accounting failure could cause duplicate submission. The next expensive operation performs strict preflight reconciliation and catches up from cumulative provider usage.

Status retrieval is allowed without hard budget admission because it is used to establish current state; usage observation on the read path is best-effort.

## 9. Streaming budget boundary

Provider event streams are currently opaque bytes at the Provider interface. The gateway therefore enforces budget immediately before opening a stream and reconciles cumulative provider usage when it ends.

This is not precise mid-stream cutoff. Future adapters should expose incremental usage events/callbacks before the gateway claims continuous in-flight hard-stop enforcement.

## 10. Control Plane

Responsibilities include tenant/project/key lifecycle, Provider/Channel/Credential lifecycle, trusted plugin catalog, routing policy, quota/budget policy, billing account/pricing/wallet/invoice configuration, usage/ledger investigation, reconciliation, audit and operator workflows.

Provider/Channel/Credential mutations currently trigger an in-process registry rebuild. A future distributed Control Plane should publish versioned configuration changes instead.

## 11. Persistence

### Postgres — durable truth

Implemented source of truth:

- tenants / projects / virtual-key hashes
- Control Principals / Role Bindings / AuditEvents
- Providers / encrypted Credentials / Channels
- SessionBindings and binding lifecycle
- Data Plane and Control Plane idempotency
- BillingAccounts
- effective PriceRules
- immutable UsageEvents
- UsageSettlements
- UsageCounters + measurement watermarks
- Reservations
- immutable LedgerEntries + price snapshots

Future durable domains include richer routing policies, plan/default budget policy, invoices/payments and execution-level usage attribution.

### Redis — reconstructable runtime state

Redis contains request rate windows, concurrency leases, hot Session cache and Channel circuit state. Redis is never the financial, Credential or Session-affinity source of truth.

## 12. Idempotency

Session creation uses `Idempotency-Key` scoped by Tenant + VirtualKey + operation. The fingerprint includes the body and routing/budget hints.

A failed Data Plane execution may release a pending claim when no successful upstream side effect occurred. Once provider work has succeeded, a failed durable idempotency completion must not release the claim because immediate replay could duplicate provider work.

## 13. Billing pipeline

```text
Provider cumulative Session usage
        |
        v
UsageCounter lock + measured_at watermark
        |
        v
Immutable delta UsageEvent
        |
        v
Effective PriceRule lookup
        |
        v
UsageSettlement
        |
        +------> upstream LedgerEntry
        |
        +------> customer LedgerEntry
                       |
                       v
              Reservation consumption
                       |
                       v
                 Budget Guard
```

Provider Session `usage` is evidence, not the ledger itself. Only the unconsumed part of an active Reservation remains an outstanding hold, avoiding double-counting spend already represented in the Ledger.

## 14. Reliability

New Sessions skip disabled, unhealthy or circuit-open Channels. Existing Sessions never transparently reroute because provider-native state would be lost.

Runtime-registry rebuilds preserve Channel IDs. Financial post-operation reconciliation failures are observable but do not falsify an already successful upstream mutation; strict preflight on the next expensive operation is the recovery boundary. Reservation expiry is the safety net for failed explicit release.

## 15. Security

- upstream provider Credentials never reach callers
- Provider/Channel config rejects secret-like fields
- Credential master keys never live in Postgres
- durable Virtual Keys are hashed at rest
- every Data Plane request resolves a Tenant
- Project-scoped keys cannot access another Project's Session
- financial attribution uses the Session's durable Tenant/Project rather than body-supplied identity
- logs/traces redact caller/provider secrets
- administrative mutations require RBAC + audit

## 16. Extensibility

Provider packages implement a small adapter interface. Core routing knows Channels and capabilities, not vendor SDKs.

Billing runtime depends on a structural billing store contract rather than provider-specific pricing logic, so future storage/backoffice implementations can preserve the same lifecycle boundary.