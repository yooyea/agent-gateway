# Architecture

## 1. System boundary

Agent Gateway is independent infrastructure between arbitrary callers and heterogeneous Agent runtimes.

```text
                         CALLERS
          SaaS / IDE / CI / Internal Platform
                            |
                     Virtual API Key
                            |
                            v
+----------------------------------------------------------+
|                      DATA PLANE                          |
| Auth -> Commercial Policy -> Runtime Admission           |
|      -> Billing Admission -> Session Router              |
|      -> Session Affinity -> Provider Channel -> Runtime  |
+----------------------------+-----------------------------+
                             |
                events / usage / traces
                             |
+----------------------------v-----------------------------+
|                    CONTROL PLANE                         |
| Tenants / Projects / Keys / RBAC / Audit                 |
| Providers / Channels / Credentials                       |
| Plans / PlanVersions / Subscriptions                     |
| Pricing / Reservation / Usage / Ledger                   |
| Routing / Quota / Rate / Concurrency                     |
+----------------------------------------------------------+
```

Both planes currently run in one Node process. Their boundaries remain explicit so they can be split later.

## 2. Provider, Channel and Credential

`Provider` is a runtime adapter implementation. `Channel` is one routable Provider instance/account/configuration. `Credential` contains encrypted provider authentication material and may be referenced only by Channels of the same Provider.

Postgres Provider/Channel/Credential records are runtime source of truth. Database values cannot import arbitrary plugin modules; trusted module mapping stays server-side.

## 3. Credential security

Credential payloads are AES-256-GCM encrypted before persistence. Master keys never enter Postgres. Authenticated data binds ciphertext to Credential + Provider identity.

Rotation supports multiple decrypt keys plus one active encryption key; old keys remain until all Credentials and encrypted idempotency replay envelopes no longer require them.

## 4. Commercial contract layer

The commercial layer sits between Tenant identity and runtime/billing admission:

```text
Plan
  -> immutable PlanVersion
      -> Tenant Subscription
          -> resolved CommercialPolicy
```

`Plan` is mutable product identity. `PlanVersion` is immutable terms. `Subscription` pins a Tenant to one exact PlanVersion for a non-overlapping interval.

`CommercialPolicy` is a runtime projection, not financial truth. It currently supplies:

- default Session budget
- requests per minute
- max caller concurrency
- included-credit entitlement metadata
- non-secret entitlements

Postgres is authoritative. A future Redis cache may accelerate policy lookup only as reconstructable state.

## 5. Data Plane admission order

For each authenticated request:

```text
VirtualKey -> Tenant / Project
        |
        v
resolve active CommercialPolicy
        |
        +--> RPM / concurrency admission
        |
        v
route-specific work
```

Environment RPM/concurrency values are fallback defaults. Active Plan values override them when defined.

For new Session creation:

```text
caller routing + optional explicit budget
        |
        v
apply Plan default budget only if caller omitted one
        |
        v
select Channel
        |
        v
persist agsess_* / state=creating
        |
        v
if billed: reserve exact capacity and attach Reservation
        |
        v
create provider Session
```

The effective Session budget is included in idempotency fingerprinting and persisted with the Session. Later commercial changes never rewrite it.

## 6. Session affinity

The selected Channel is persisted before provider creation. Once bound, every later Session operation returns to that Channel.

Disabled Channels, circuit breakers, commercial plan changes, and routing changes affect future admission/routing only; they never silently move an existing Session.

## 7. Billing runtime

`@agent-gateway/billing-runtime` coordinates Agent lifecycle with durable Billing primitives:

```text
SessionStore.create
  -> BillingAccount lookup
  -> Reservation admission
  -> attach Reservation

GatewaySession usage
  -> cumulative normalization
  -> UsageEvent delta
  -> settlement / Ledger

follow-up Agent work
  -> provider usage refresh
  -> fail closed on unresolved pricing
  -> Reservation renewal if needed
  -> SessionBudget guard
```

Wrapping order:

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

## 8. Follow-up work admission

For billed event submission/streaming:

```text
resolve Tenant/Project + current CommercialPolicy
        |
        v
caller concurrency admission
        |
        v
exclusive per-Session lease
        |
        v
GET provider Session snapshot
        |
        v
normalize + settle cumulative usage
        |
        v
assert remaining SessionBudget
        |
        v
POST events / open stream
```

Preflight is fail-closed. Post-success reconciliation is best-effort to avoid turning successful upstream mutations into duplicate client retries.

Provider event streams are currently opaque bytes, so continuous mid-stream budget cutoff is not yet claimed.

## 9. Included-credit boundary

PlanVersion `included_credit_micros` is currently a commercial entitlement declaration only.

It is deliberately not injected into BillingAccount balance. The next layer materializes period-scoped CreditBuckets and immutable Ledger grant/expiry entries so commercial contract changes cannot silently alter financial history.

## 10. Control Plane

Control Plane domains include:

- Tenant / Project / Virtual Key
- ControlPrincipal / RoleBinding / Audit
- Provider / Channel / Credential
- BillingAccount / PriceRule / Usage / Ledger / Reservation
- Plan / PlanVersion / Subscription / CommercialPolicy

Billing and Commercial mutations reuse the same governance boundary:

```text
resource mutation
+ success AuditEvent
+ completed encrypted idempotency replay
= one Postgres transaction
```

Runtime-only derived work happens after durable commit.

## 11. Persistence

### Postgres — durable truth

Implemented durable domains:

- Tenants / Projects / VirtualKey hashes
- ControlPrincipals / RoleBindings / AuditEvents
- Providers / encrypted Credentials / Channels
- Plans / immutable PlanVersions / Subscriptions
- SessionBindings / Data Plane + Control Plane idempotency
- BillingAccounts / PriceRules
- immutable UsageEvents / UsageSettlements / UsageCounters
- Reservations / immutable LedgerEntries

Future durable domains include CreditBuckets, payment/invoice records, subscription renewal events, richer quota counters, and execution-level metering.

### Redis — reconstructable runtime state

Redis contains rate windows, concurrency leases, hot Session cache, and Channel circuit state. It is never commercial-contract or financial truth.

## 12. Idempotency

Data Plane Session creation is scoped by Tenant + VirtualKey + operation + key and fingerprints body + routing/capability hints + **effective** Session budget after commercial defaulting.

Control Plane mutations are scoped by actor + operation + key, with encrypted completed replay state where needed.

Potentially side-effecting upstream failures remain protected rather than releasing idempotency state prematurely.

## 13. Financial pipeline

```text
Provider cumulative usage
        |
        v
UsageCounter + provider watermark
        |
        v
immutable UsageEvent delta
        |
        v
PriceRule at measured_at
        |
        v
UsageSettlement
        |
        +--> upstream LedgerEntry
        |
        +--> customer LedgerEntry
                    |
                    v
             Reservation consumption
```

UsageEvent and LedgerEntry are immutable. Corrections append explicit adjustments/refunds.

## 14. Reliability boundaries

- Postgres is identity, commercial, affinity, governance, and financial source of truth.
- Redis loss may lose caches/leases/windows, never contracts or financial history.
- Existing Session affinity survives Channel health/config changes.
- Commercial policy can alter current admission defaults, not historical Session/financial state.
- Provider success is not reclassified as failure solely because best-effort local reconciliation fails afterward.
