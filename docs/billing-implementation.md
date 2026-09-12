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
  -> hard max_cost_usd required
  -> Reservation must succeed before Provider call

POST /agents/sessions/{id}/events
GET  /agents/sessions/{id}/events (SSE)
  -> retrieve current provider Session
  -> strictly reconcile cumulative usage
  -> assert remaining SessionBudget
  -> only then admit new Agent work
```

Tenants without a BillingAccount keep the unbilled/legacy path.

Provider Session creation failure releases the active Reservation best-effort. Reservation expiry is the fallback for release failure.

Post-provider usage reconciliation is best-effort after a mutation has already succeeded, because reporting local accounting failure as an upstream mutation failure can cause duplicate caller retries. The next expensive operation catches up through strict preflight reconciliation.

## Financial invariants

- `UsageEvent` is append-only evidence. Provider corrections produce adjustment events rather than mutation of prior usage facts.
- `UsageSettlement` is separate processing state and may move from `no_price` to `settled` without rewriting UsageEvent evidence.
- `LedgerEntry` is immutable financial history. Corrections append refund/adjustment entries.
- Stored money uses integer USD micros / exact database numerics. JavaScript floating point is not a ledger source of truth.
- `PriceRule` is effective-dated and every settled LedgerEntry stores a price snapshot, so later price changes cannot rewrite history.
- Reservations serialize against the Tenant BillingAccount, preventing concurrent Sessions from spending the same capacity.
- Only the unconsumed Reservation amount remains held; customer Ledger spend is not double-counted as a full outstanding hold.
- Concurrent first usage observations serialize through a durable counter row.
- Repeated cumulative provider snapshots charge only the delta since the previous observation.
- Provider measurement watermarks reject stale/out-of-order cumulative snapshots.
- A lower newer cumulative observation is represented as a negative adjustment and can produce a customer credit/refund.
- Project-scoped Virtual Keys cannot access another Project's Session.

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
- failed Session Reservation release
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