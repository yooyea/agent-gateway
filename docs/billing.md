# Metering and Billing

## 1. Principle

Agent billing is lifecycle billing, not request billing.

A single Session may generate model tokens, sandbox compute, web/file search, storage, tools and subagent work over many events. Some provider usage is best-effort or corrected later.

Therefore:

```text
provider usage != immutable customer ledger
```

## 2. Monetary layers

The platform keeps at least two monetary views:

```text
Upstream Cost: what the gateway owes providers
Customer Charge: what the tenant owes the gateway
```

Each is calculated from versioned PriceRules and usage facts.

## 3. UsageEvent

Usage is normalized into append-only events such as:

```text
model.input_tokens
model.cached_input_tokens
model.output_tokens
sandbox.compute_seconds
web_search.call
file_search.call
storage.gb_seconds
tool.call
provider.other
```

A UsageEvent should include:

- tenant/project/session/execution
- provider/channel
- unit type
- quantity
- measured_at
- provider source/reference
- provisional/final state
- raw evidence reference

## 4. PriceRule

A PriceRule is effective-dated.

Example dimensions:

- provider
- model
- service tier
- unit type
- tenant/plan
- effective start/end

It yields upstream unit cost and/or customer unit price.

The PriceRule snapshot used during settlement must be referenced by the resulting ledger entry.

## 5. Reservation

Long-running Agent executions can overspend if the platform only charges after completion.

Before admitting work, the gateway should reserve capacity:

```text
available_balance = balance - active_reservations
```

Example:

```text
wallet balance       $10.00
new session budget    $2.00
reserved               2.00
available              8.00
```

If the session settles at `$0.74`, release `$1.26` and post the final charge.

Reservation also prevents many concurrent sessions from each believing they can spend the same remaining dollar.

## 6. SessionBudget

Supported policy dimensions should include:

```json
{
  "max_cost_usd": 2.0,
  "max_duration_seconds": 1800,
  "max_iterations": 100,
  "max_subagents": 5
}
```

Budget enforcement stages:

1. admission check
2. reservation
3. continuous estimated-cost update
4. warning threshold policy
5. hard stop / deny additional work
6. settlement
7. release unused reservation

## 7. Settlement

A normal flow:

```text
UsageEvent (provisional)
       |
       v
Price lookup at effective time
       |
       v
Provisional Cost/Charge
       |
       v
Reservation consumption
       |
       v
LedgerEntry
```

LedgerEntry is immutable.

## 8. Reconciliation

Provider truth may arrive later or may differ from an intermediate session usage snapshot.

Reconciliation compares:

```text
what we provisionally measured
vs
what provider records eventually report
```

Difference is represented by adjustment UsageEvents/LedgerEntries.

Never mutate the old LedgerEntry to make history disappear.

## 9. Ledger

Recommended double-entry-inspired event categories:

- reservation.hold
- reservation.release
- usage.charge
- usage.refund
- reconciliation.adjustment
- credit.grant
- credit.expire
- payment
- manual.adjustment

Even if the first implementation is a simpler balance ledger, entries must be immutable and idempotent.

## 10. Pricing strategies

The SaaS may support:

- pass-through upstream price
- percentage markup
- fixed per-unit markup
- provider/model multiplier
- tool/sandbox-specific multiplier
- plan-based included credits
- enterprise negotiated price table

The routing engine may later consider both upstream cost and sell margin, but financial policy must never silently violate tenant provider/capability constraints.

## 11. Data consistency

Financial writes require:

- database transaction
- idempotency key
- unique provider usage reference where possible
- integer minor units or exact decimal arithmetic
- currency field
- immutable timestamps and price snapshots

Floating-point arithmetic must not be the source of truth for stored money.
