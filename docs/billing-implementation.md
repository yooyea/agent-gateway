# Billing Implementation Status

This document tracks the executable v0.5 financial layer for Agent Gateway.

## Runtime flow

```text
new billed Session
  -> persist SessionBinding(state=creating)
  -> reserve max-cost capacity
  -> attach Reservation
  -> create provider Session

provider cumulative usage
  -> UsageCounter lock + measured_at watermark
  -> immutable delta UsageEvent
  -> effective-dated PriceRule lookup
  -> UsageSettlement
  -> immutable upstream/customer LedgerEntry
  -> Reservation consumption
  -> SessionBudget remaining capacity
```

## Data Plane admission

For a Tenant with an enabled BillingAccount:

```text
POST /agents/sessions
  -> X-Agent-Gateway-Max-Cost-USD required
  -> parse directly to exact USD micros
  -> Reservation must succeed before Provider call

POST /agents/sessions/{id}/events
GET  /agents/sessions/{id}/events (SSE)
  -> acquire per-Session exclusive runtime lease
  -> retrieve current provider Session
  -> strictly reconcile cumulative usage
  -> fail closed if customer pricing is unresolved
  -> renew/reacquire an expired Reservation lease if capacity remains
  -> assert remaining SessionBudget
  -> only then admit new Agent work
```

Tenants without a BillingAccount keep the unbilled/legacy path.

The max-cost header is never converted through JavaScript floating point. The validated decimal is converted directly to integer USD micros and that exact value participates in durable Session budget state and the Session-create idempotency fingerprint.

A Reservation is released automatically only when failure is known to occur during pre-provider admission. After provider invocation starts, a generic binding/provider error is treated as potentially side-effecting; its financial hold is retained until explicit reconciliation or expiry rather than risking unreserved upstream spend.

Post-provider usage reconciliation is best-effort after a mutation has already succeeded, because reporting local accounting failure as an upstream mutation failure can cause duplicate caller retries. The next expensive operation catches up through strict preflight reconciliation.

Reservation TTL is an operational lease, not an implicit Session lifetime. A live Session with unused budget renews its Reservation under the BillingAccount lock. If another workload has consumed the released capacity while the hold was expired, renewal fails closed with insufficient capacity.

## Financial invariants

- `UsageEvent` is append-only evidence. Provider corrections produce adjustment events rather than mutation of prior usage facts.
- `UsageSettlement` is separate processing state and may move from `no_price` to `settled` without rewriting UsageEvent evidence.
- `LedgerEntry` is immutable financial history. Corrections append refund/adjustment entries.
- Stored money uses integer USD micros / exact database numerics. JavaScript floating point is not a ledger source of truth.
- Northbound max-cost limits are normalized directly to exact micros before persistence or idempotency hashing.
- `PriceRule` is effective-dated and every settled LedgerEntry stores a price snapshot, so later price changes cannot rewrite history.
- A billed Session with observed usage but no customer PriceRule is not allowed to admit more work.
- Reservations serialize against the Tenant BillingAccount, preventing concurrent Sessions from spending the same capacity.
- Per-Session runtime leases serialize budget admission and upstream work so two concurrent requests cannot both pass the same remaining budget snapshot.
- Only the unconsumed Reservation amount remains held; customer Ledger spend is not double-counted as a full outstanding hold.
- Concurrent first usage observations serialize through a durable counter row.
- Repeated cumulative provider snapshots charge only the delta since the previous observation.
- Provider measurement watermarks reject stale/out-of-order cumulative snapshots.
- A lower newer cumulative observation is represented as a negative adjustment and can produce a customer credit/refund.
- Project-scoped Virtual Keys cannot access another Project's Session.
- Ambiguous post-provider failures never release financial capacity merely because the local SessionBinding is marked failed.

## Packages

### `@agent-gateway/billing-postgres`

Owns durable financial persistence and settlement mathematics:

- BillingAccount
- PriceRule
- UsageEvent
- UsageSettlement
- UsageCounter
- Reservation
- LedgerEntry
- cumulative usage normalization / settlement / reconciliation primitives

### `@agent-gateway/billing-runtime`

Owns Agent lifecycle coordination:

- pre-provider Session Reservation
- exact-micros SessionBudget admission
- renewable Reservation lease enforcement
- unresolved-customer-pricing fail-closed checks
- GatewaySession usage observation normalization
- SessionBudget assertion boundary

It intentionally does not own routing or pricing policy.

## Current limitation

Provider SSE is currently exposed as opaque bytes. v0.5 enforces budget immediately before opening a stream and reconciles cumulative usage after completion. Precise mid-stream hard-stop enforcement requires incremental usage observability from Provider adapters.

## Next financial layer

The next Control Plane increment should expose permissioned/audited management for:

- BillingAccount enablement and credit limit
- PriceRule lifecycle
- explicit credit grant / manual adjustment
- Reservation inspection
- UsageEvent / UsageSettlement queries
- Ledger queries
- reconciliation operations

Those mutations must reuse the existing Control Plane transaction, idempotency and append-only Audit guarantees.
