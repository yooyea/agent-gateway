# Metering and Billing

## 1. Principle

Agent billing is lifecycle billing, not request billing.

A single Session may generate model tokens, sandbox compute, web/file search, storage, tools and subagent work over many events. Some provider usage is best-effort or corrected later.

Therefore:

```text
provider usage != immutable customer ledger
```

The implemented financial path separates four concerns:

```text
Provider cumulative usage
        -> immutable UsageEvent delta
        -> mutable UsageSettlement state
        -> immutable LedgerEntry
        -> Reservation consumption / SessionBudget guard
```

## 2. Monetary layers

The platform keeps at least two monetary views:

```text
Upstream Cost: what the gateway owes providers
Customer Charge: what the tenant owes the gateway
```

Each is calculated from effective-dated PriceRules and usage facts.

Stored money uses integer USD micros. JavaScript floating-point values are never the durable source of truth for money.

## 3. BillingAccount

A Tenant becomes billed when it has a `BillingAccount`.

Current Data Plane behavior is intentionally explicit:

- Tenant without BillingAccount: legacy/unbilled execution remains allowed.
- Tenant with enabled BillingAccount: new Sessions require a positive hard `max_cost_usd` budget.
- Tenant with disabled BillingAccount: new billed work is rejected.

A later plan/policy layer may supply tenant defaults. Until then, a billed caller declares the hard budget through the Data Plane budget header.

## 4. UsageEvent

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

A UsageEvent includes the durable attribution needed for settlement:

- tenant/project/session
- provider/channel
- metric and delta quantity
- measured_at
- provider source/reference
- provisional/final/adjustment finality
- non-secret metadata

`gateway_usage_events` is database-enforced append-only. Provider corrections create adjustment events; they never rewrite an older usage fact.

## 5. Cumulative provider usage and counters

Provider Session usage may be cumulative and may be observed repeatedly.

The gateway keeps one durable counter per Session + metric and computes:

```text
new cumulative observation - previously observed cumulative value = UsageEvent delta
```

The counter row is created before it is locked, so even two concurrent first observations serialize correctly.

Each counter also stores a provider measurement watermark. An observation older than the current watermark is ignored rather than rolling the cumulative value backward.

Equal cumulative observations may advance the watermark but do not create a duplicate UsageEvent or charge.

A lower newer cumulative value is treated as a provider correction and creates a negative adjustment delta.

## 6. UsageSettlement

Usage facts and processing state are intentionally separate.

`UsageEvent` is immutable evidence. `UsageSettlement` records whether that fact currently has a usable PriceRule:

```text
no_price
settled -> price_rule_id
```

This allows a historical `no_price` usage event to be settled later without mutating the original evidence.

## 7. PriceRule

A PriceRule is effective-dated.

Supported dimensions include:

- tenant override or global rule
- provider
- model
- metric
- unit scale
- upstream unit price
- customer unit price
- effective start/end

The rule selected at the UsageEvent measurement time is snapshotted onto the resulting LedgerEntry. Later price changes cannot rewrite historical charges.

## 8. Reservation

Long-running Agent executions can overspend if the platform only charges after completion.

For a billed Tenant, Session creation follows:

```text
persist SessionBinding(state=creating)
        |
        v
resolve BillingAccount
        |
        v
reserve max_cost_usd capacity
        |
        v
attach Reservation to agsess_...
        |
        v
only then call the upstream Provider
```

If reservation/admission fails, the upstream Provider is never contacted.

If Provider Session creation later fails, the active Reservation is released best-effort. A hold also has an expiry so a release failure cannot reserve capacity forever.

Available capacity accounts for customer Ledger balance and only the **unconsumed** part of active Reservations:

```text
available = credit_limit + ledger_balance - active_unconsumed_reservations
```

Consumed spend is already represented by the Ledger, so it must not also remain fully held by the Reservation.

Reservation admission locks the Tenant BillingAccount row so concurrent Sessions cannot spend the same remaining capacity.

## 9. SessionBudget

The policy shape supports:

```json
{
  "max_cost_usd": 2.0,
  "max_duration_seconds": 1800,
  "max_iterations": 100,
  "max_subagents": 5
}
```

The first hard-enforced financial dimension is `max_cost_usd`.

For billed Tenants the Data Plane receives it through:

```http
X-Agent-Gateway-Max-Cost-USD: 2.00
```

The value must be positive and may contain at most six decimal places.

Before additional Agent work (`POST /events` and event streaming), the gateway:

1. resolves the durable Session and Project context,
2. retrieves the current provider Session usage,
3. strictly normalizes and settles the latest cumulative usage,
4. evaluates the remaining Reservation/SessionBudget,
5. contacts the Provider only if admission still passes.

An exhausted budget fails before additional provider work.

Status-only `GET /agents/sessions/{id}` is not treated as new Agent work; it may retrieve the Session and best-effort observe usage.

## 10. Runtime settlement behavior

After Session creation, retrieve, event submission, and stream completion, provider Session usage can be observed and settled.

There are two accounting modes on the hot path:

### Fail-closed preflight

Before expensive follow-up work, usage refresh + settlement is strict. If the gateway cannot establish current billable state, it does not knowingly admit more work.

### Best-effort post-provider reconciliation

After an upstream mutation has already succeeded, a local usage-refresh failure must not turn that success into a client-visible failure that encourages the caller to submit the same mutation again.

The gateway logs the reconciliation failure. The next expensive operation performs the strict preflight again and catches up from cumulative provider usage.

## 11. Streaming limitation

The current provider abstraction returns opaque SSE bytes. Therefore v0.5 performs hard budget admission immediately before opening a stream and reconciles provider cumulative usage when the stream ends.

A very long stream can consume beyond the last preflight estimate before the gateway sees a final cumulative Session snapshot.

Future incremental streaming metering should parse provider-native usage events or expose a provider usage callback so the gateway can stop an in-flight stream near its hard budget. Until that exists, the Reservation remains the maximum authorized financial hold and post-stream reconciliation records the actual observed usage.

## 12. Settlement and Ledger

A normal flow:

```text
UsageEvent
       |
       v
Price lookup at measured_at
       |
       v
UsageSettlement
       |
       +--------> upstream LedgerEntry
       |
       +--------> customer LedgerEntry
                         |
                         v
              Reservation consumed_micros
```

`LedgerEntry` is immutable and idempotent.

Customer positive usage creates a debit. A negative provider correction creates a credit/refund. Upstream cost uses its own ledger book.

## 13. Reconciliation

Provider truth may arrive later or may differ from an intermediate Session usage snapshot.

Reconciliation compares cumulative provider truth with the durable UsageCounter. The delta becomes a new UsageEvent and corresponding LedgerEntries.

Never mutate old UsageEvents or LedgerEntries to make history disappear.

## 14. Ledger event categories

Current/future categories include:

- reservation.hold
- reservation.release
- usage.charge
- usage.refund
- reconciliation.adjustment
- credit.grant
- credit.expire
- payment
- manual.adjustment

The current Reservation is represented as durable mutable hold state rather than a separate hold/release ledger pair. Financial charge/refund entries themselves remain immutable.

## 15. Pricing strategies

The SaaS may support:

- pass-through upstream price
- percentage markup
- fixed per-unit markup
- provider/model multiplier
- tool/sandbox-specific multiplier
- plan-based included credits
- enterprise negotiated price table

The routing engine may later consider both upstream cost and sell margin, but financial policy must never silently violate tenant provider/capability constraints.

## 16. Data consistency invariants

Financial code must preserve these invariants:

- Postgres is the financial source of truth.
- Reservation admission serializes against the Tenant BillingAccount.
- A billed Session reserves capacity before upstream Session creation.
- The same consumed dollar is never counted in both Ledger spend and the full Reservation hold.
- UsageEvent and LedgerEntry are append-only at the database layer.
- Usage settlement state is stored separately from UsageEvent evidence.
- cumulative usage counters serialize concurrent first observations.
- stale provider observations do not move a counter watermark backward.
- provider corrections are explicit negative deltas, not history rewrites.
- every LedgerEntry snapshots the price rule used to produce it.
- money is stored in integer micros / exact database numeric arithmetic.
- successful upstream mutations are not reported as failed solely because best-effort post-operation accounting refresh failed.
- the next expensive operation must fail closed if current usage/budget state cannot be established.