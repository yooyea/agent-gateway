# Metering and Billing

## 1. Principle

Agent billing is lifecycle billing, not request billing.

A single Session may consume model tokens, sandbox compute, search/tool calls and provider-specific resources over many operations. Provider usage may be cumulative, provisional, delayed or corrected later.

Therefore:

```text
provider usage != immutable customer ledger
```

The implemented financial path is:

```text
Provider cumulative usage
        -> immutable UsageEvent delta
        -> UsageSettlement state
        -> immutable upstream/customer LedgerEntry
        -> Reservation consumption
        -> SessionBudget admission
```

## 2. Monetary layers

The gateway keeps separate monetary views:

```text
Upstream Cost   = what the gateway owes a Provider
Customer Charge = what a Tenant owes the gateway
```

They may use different prices.

All durable money is stored as integer USD micros or exact database numerics. JavaScript floating point is never the source of truth for financial values.

## 3. BillingAccount

A Tenant becomes billed when a `BillingAccount` exists.

Current Data Plane behavior:

- no BillingAccount: legacy/unbilled execution remains allowed;
- enabled BillingAccount: new Sessions require a positive hard max-cost budget;
- disabled BillingAccount: new billed work is rejected.

`credit_limit_micros` is an admission facility, not an immutable ledger event. Credits/payments/manual adjustments belong in Ledger entries.

Available capacity is:

```text
available = credit_limit + customer_ledger_balance - active_unconsumed_reservations
```

## 4. UsageEvent

Current normalized metrics are:

```text
model.input_tokens
model.cached_input_tokens
model.output_tokens
sandbox.compute_seconds
web_search.call
file_search.call
tool.call
provider.other
```

`UsageEvent` stores durable attribution:

- Tenant / optional Project / Session
- Provider / Channel / optional model
- metric + delta quantity
- provider measurement time
- observation/source reference
- provisional/final/adjustment finality
- non-secret metadata

`gateway_usage_events` is database-enforced append-only.

Provider corrections create new adjustment UsageEvents. They never rewrite older evidence.

## 5. Cumulative provider usage

Provider Session usage may be cumulative. The gateway stores one counter per Session + metric:

```text
new cumulative quantity - previous cumulative quantity = new UsageEvent delta
```

The counter row is created before `FOR UPDATE`, so even two concurrent first observations serialize.

Each counter also stores a provider `measured_at` watermark:

- older observations are ignored;
- equal cumulative observations may advance the watermark without creating charge;
- lower but newer cumulative observations produce negative adjustment deltas.

## 6. UsageSettlement

Usage evidence and processing state are separate.

```text
UsageEvent = immutable fact
UsageSettlement = settlement processing state
```

Current states:

```text
no_price
settled -> price_rule_id
```

A historical `no_price` event may later become settled without changing the original UsageEvent.

For live billed Agent work, however, unresolved **customer** pricing is fail-closed: the gateway does not knowingly admit more expensive work while the customer charge is indeterminate.

## 7. PriceRule

A PriceRule is effective-dated and may constrain:

- Tenant override or global rule
- Provider type
- model
- metric
- unit scale
- upstream unit price
- customer unit price
- effective start/end

The rule selected at UsageEvent measurement time is snapshotted onto every resulting LedgerEntry. Later price changes do not rewrite historical charges.

v0.6 exposes create/list only. There is no in-place PriceRule update/delete API; policy changes are represented by new effective-dated rules.

## 8. Reservation

A Reservation prevents concurrent long-running Agents from all spending the same remaining capacity.

For a billed Tenant, Session creation follows:

```text
persist SessionBinding(state=creating)
        -> resolve BillingAccount
        -> reserve exact max-cost capacity
        -> attach Reservation to agsess_...
        -> only then call Provider
```

If admission fails before Provider invocation, the Provider is never contacted and the pre-provider hold may be released safely.

Once Provider invocation may have started, a generic Session binding/provider failure is treated as potentially side-effecting. The Reservation is **not** automatically released merely because local binding later reports failure; an upstream Session may already exist and accrue cost.

Only the unconsumed part of an active Reservation remains held. Consumed customer spend is already represented in the Ledger and is not double-held.

Reservation admission serializes against the Tenant BillingAccount.

## 9. Reservation expiry and renewal

Reservation TTL is operational lease state, not a hidden Session lifetime.

Before later billed Agent work, an expired active Reservation with remaining budget is renewed/reacquired under the BillingAccount lock.

If the capacity was consumed by other work while the hold was expired, renewal fails closed with insufficient billing capacity.

## 10. SessionBudget

The policy shape supports:

```json
{
  "max_cost_micros": "2000000",
  "max_duration_seconds": 1800,
  "max_iterations": 100,
  "max_subagents": 5
}
```

The northbound Data Plane header remains human-friendly:

```http
X-Agent-Gateway-Max-Cost-USD: 2.00
```

The header:

- must be positive;
- accepts at most six decimal places;
- is converted directly from decimal text to exact integer micros;
- never passes through JavaScript floating point;
- participates in Session-create idempotency fingerprinting in normalized micros form.

## 11. Data Plane financial admission

Before `POST /events` or SSE stream work for a billed Session, the gateway holds an exclusive per-Session runtime lease and executes:

```text
retrieve provider Session
  -> observe cumulative usage
  -> settle usage delta
  -> verify customer pricing is resolved
  -> renew/reacquire Reservation if necessary
  -> assert remaining SessionBudget
  -> only then contact Provider
```

The per-Session lease prevents overlapping operations from both passing the same budget snapshot.

A status-only Session GET is not new expensive work; it may retrieve provider state and best-effort observe usage.

## 12. Post-provider reconciliation

After an upstream mutation succeeds, accounting reconciliation is best-effort.

A local accounting refresh failure must not turn an already-successful upstream mutation into a client-visible failure that encourages duplicate submission.

The next expensive operation performs strict preflight again and catches up from cumulative provider usage.

## 13. Streaming limitation

Provider streams are currently opaque bytes at the gateway Provider interface.

v0.5/v0.6 therefore:

1. enforce budget immediately before stream admission;
2. hold the per-Session runtime lease for the stream;
3. reconcile cumulative usage after stream completion.

Precise mid-stream cutoff requires Provider adapters to expose incremental usage events/callbacks.

## 14. Ledger

A normal settlement path:

```text
UsageEvent
   -> effective PriceRule
   -> UsageSettlement
   -> upstream LedgerEntry
   -> customer LedgerEntry
   -> Reservation consumed_micros
```

`LedgerEntry` is immutable and idempotent.

Positive customer usage creates a debit. A negative provider correction creates a credit/refund.

Current/future Ledger categories include:

- `usage.charge`
- `usage.refund`
- `reconciliation.adjustment`
- `credit.grant`
- `credit.expire`
- `payment`
- `manual.adjustment`

The Reservation itself is mutable hold state rather than a separate hold/release Ledger pair in the current implementation.

## 15. Billing Control Plane

v0.6 exposes governed financial management under:

```text
/api/gateway/admin/billing/*
```

Current resources/actions:

```text
BillingAccount     read / upsert / exposure
PriceRule          list / create
Credit             append immutable customer credit LedgerEntry
UsageEvent         query
LedgerEntry        query
Reservation        query
```

### Permissions

Billing permissions are explicit domain permissions:

```text
billing.accounts.read
billing.accounts.write
billing.pricing.read
billing.pricing.write
billing.credits.write
billing.usage.read
billing.ledger.read
billing.reservations.read
```

Role bundles:

- `owner`: all billing permissions
- `admin`: all billing permissions
- `operator`: billing reads only
- `viewer`: billing reads only

Tenant-scoped RoleBindings apply only to the matching Tenant.

Global PriceRule operations and unfiltered/cross-Tenant financial reads require a global binding.

### Billing mutation correctness

Every Billing Control Plane mutation requires `Idempotency-Key`.

The durable unit is:

```text
financial mutation
+ success AuditEvent
+ encrypted completed idempotency replay
= one Postgres transaction
```

Failure rolls back that durable unit before a separate error AuditEvent is appended.

Completed replay returns the original response without repeating the financial mutation and records new audit evidence for the current request.

Financial mutation bodies use integer micros strings. Floating-point money input is not accepted.

### Credit grants

Credit grant appends an immutable customer LedgerEntry (`credit.grant`).

The Ledger idempotency key is scoped by:

```text
ControlPrincipal + billing.credit.grant + Tenant + management Idempotency-Key
```

This prevents a reused actor key in another Tenant from accidentally colliding with the first credit entry.

## 16. Reconciliation

Provider truth may arrive later or differ from an intermediate Session snapshot.

Reconciliation compares provider cumulative truth with the durable UsageCounter. Difference becomes a new UsageEvent and corresponding Ledger entries.

Never mutate old UsageEvents or LedgerEntries to make history disappear.

## 17. Pricing strategy roadmap

The commercial layer may support:

- pass-through upstream price
- percentage/fixed markup
- provider/model multiplier
- tool/sandbox-specific pricing
- plan included credits
- enterprise negotiated price table

The routing engine may later consider upstream cost and sell margin, but financial optimization must never silently violate Tenant/provider/capability policy.

## 18. Financial invariants

Financial code must preserve all of the following:

- Postgres is financial source of truth.
- money is exact integer micros / exact database numeric arithmetic.
- billed Session capacity is reserved before upstream Session creation.
- Reservation admission serializes against the Tenant BillingAccount.
- expired Reservation lease is renewed under BillingAccount lock rather than silently extending spend.
- ambiguous post-provider failures do not automatically release financial exposure.
- per-Session Agent work serializes budget admission.
- unpriced observed customer usage blocks additional billed work.
- consumed customer spend is not double-counted in full Reservation hold.
- UsageEvent and LedgerEntry are append-only.
- UsageSettlement is separate from immutable usage evidence.
- stale provider observations cannot move cumulative counters backward.
- provider corrections append explicit negative deltas.
- every settled LedgerEntry snapshots its PriceRule.
- Billing Control Plane writes require explicit financial permission + idempotency + audit.
- billing mutation, success audit and completed replay commit atomically.
- historical finance is adjusted by append, not overwritten.
