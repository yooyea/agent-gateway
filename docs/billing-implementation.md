# Billing Implementation Status

This document tracks the first executable financial layer for Agent Gateway.

## Runtime flow

```text
provider cumulative usage
  -> normalized delta UsageEvent
  -> effective-dated PriceRule lookup
  -> immutable upstream/customer LedgerEntry
  -> Reservation consumption
  -> SessionBudget remaining capacity
```

## Financial invariants

- `UsageEvent` is append-only evidence. Provider corrections produce adjustment events rather than mutation of prior usage facts.
- `LedgerEntry` is immutable financial history. Corrections append refund/adjustment entries.
- Stored money uses integer USD micros. JavaScript floating point is not a ledger source of truth.
- `PriceRule` is effective-dated and every settled LedgerEntry stores a price snapshot, so later price changes cannot rewrite history.
- Reservations are serialized against the tenant billing account before work is admitted, preventing concurrent sessions from spending the same capacity.
- Repeated cumulative provider snapshots charge only the delta since the previous observation.
- A lower later cumulative observation is represented as a negative adjustment and can produce a customer credit/refund.

## Current v0.5 implementation boundary

The `@agent-gateway/billing-postgres` package implements the durable accounting primitives and integration tests. Data Plane admission/usage hooks and Control Plane pricing/ledger APIs are layered on top after the package invariants are green.
