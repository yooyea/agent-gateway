# Domain Ontology

This document defines the durable entities, relations, and statements that must remain true.

## 1. Identity and governance

### Tenant

The commercial and security boundary. A Tenant owns Projects, Virtual Keys, Sessions, billing state, and Subscriptions.

### Project

A namespace inside a Tenant. Sessions and Virtual Keys may be Project-scoped.

### VirtualKey

A Data Plane caller credential. It resolves to exactly one Tenant and optionally one Project. Project-scoped keys cannot access Sessions in another Project.

### ControlPrincipal

A durable Control Plane operator/service identity authenticated by a one-time `agcp_*` bearer secret. Only its hash and display prefix are durable.

### RoleBinding

Relates a ControlPrincipal to a built-in Role (`owner`, `admin`, `operator`, `viewer`) in `global` or `tenant` scope.

### Permission

A stable authorization capability. Global resources require global authorization. Tenant-scoped bindings satisfy only operations carrying the matching Tenant scope.

### AuditEvent

Append-only governance evidence for Control Plane actions. It records actor, request id, action, resource, optional Tenant, outcome, non-secret metadata, and creation time.

## 2. Runtime supply

### Provider

A runtime adapter type such as `openai-agents`.

### Credential

Encrypted secret material owned by one Provider. Master encryption keys remain outside Postgres.

### Channel

One routable Provider instance/configuration. A Channel belongs to one Provider and may reference only a Credential owned by that Provider.

### Capability

A runtime feature such as sandbox, streaming, MCP, tools, artifacts, or subagents.

## 3. Runtime demand

### Session

Gateway-owned durable Agent conversation/execution identity. Public IDs use `agsess_*`. A Session belongs to exactly one Tenant and optionally one Project.

### SessionBinding

The immutable normal routing relationship:

```text
Session -> Provider -> Channel -> ProviderSessionId
```

The selected Channel is persisted while the Session is still `creating`, before upstream Session creation. Normal traffic never silently replaces this binding.

### Execution

A bounded period of Agent work inside a Session.

### Event

A message/tool/approval/artifact/cancellation/provider-native occurrence associated with Session/Execution.

### Environment

Agent execution environment: none, provider-hosted sandbox, or external runtime.

### Artifact

A durable output produced by Agent execution.

## 4. Runtime policy

### RoutingPolicy

Determines which Channels are eligible for a new Session.

### RateLimit

A short-window throughput constraint.

### ConcurrencyLimit

A maximum simultaneous workload constraint.

### Quota

A cumulative period allowance such as requests, tokens, compute, sessions, or spend.

### SessionBudget

A hard/soft Session-level boundary. `max_cost_micros` is the first hard financial dimension. The effective Session budget is persisted at creation and is not retroactively changed by later commercial policy changes.

## 5. Commercial contract domain

### Plan

A mutable commercial product identity (`agplan_*`) with name/description/status.

### PlanVersion

An immutable commercial terms snapshot (`agplanv_*`) belonging to one Plan.

It may define:

- billing interval
- recurring price in exact micros
- included-credit entitlement in exact micros
- default Session budget
- requests per minute
- max concurrency
- non-secret entitlements
- effective timestamp

Changing an offer creates a new PlanVersion; existing versions are never updated/deleted.

### Subscription

A Tenant contract (`agsub_*`) pinned to exactly one PlanVersion and one time interval.

Commercial identity is:

```text
Tenant + PlanVersion + starts_at
```

A Tenant cannot have overlapping scheduled/active subscription intervals.

### CommercialPolicy

A runtime projection of the currently active Subscription and pinned PlanVersion. It exposes current period, Plan identity, default Session budget, RPM, concurrency, included-credit entitlement, and entitlements.

CommercialPolicy is not financial truth and does not mutate historical Sessions, UsageEvents, or LedgerEntries.

### IncludedCredit entitlement

`included_credit_micros` on PlanVersion is currently an entitlement declaration only. It is not spendable balance until a future period-scoped CreditBucket/Ledger grant materializes it.

## 6. Metering and finance

### BillingAccount

Tenant-level financial account activating billed execution and defining currency, enabled state, and credit capacity.

### UsageEvent

Append-only measured delta evidence for model tokens, sandbox duration, search/tool units, or provider-specific usage. Provider corrections append negative adjustments.

### UsageCounter

Durable Session + metric cumulative watermark. It serializes observations and rejects stale provider snapshots.

### UsageSettlement

Mutable processing state for immutable UsageEvent evidence: `no_price` or `settled` with PriceRule.

### PriceRule

Effective-dated mapping from usage dimensions to upstream cost and/or customer price.

### Cost

What the gateway owes an upstream provider.

### Charge

What a customer owes the gateway.

### Reservation

Locks customer spend capacity before uncertain long-running Agent execution. Only the unconsumed amount remains outstanding exposure.

### Settlement

Converts UsageEvent evidence under a PriceRule into LedgerEntries and consumes Reservation capacity.

### LedgerEntry

Immutable financial truth. Usage-derived entries snapshot the PriceRule used; historical entries are never recomputed.

### Reconciliation

Compares later provider truth against UsageCounter and appends adjustment UsageEvents/LedgerEntries rather than rewriting history.

## 7. Critical relations

```text
Tenant 1 --- N Project
Tenant 1 --- N VirtualKey
Tenant 1 --- N Session
Tenant 1 --- 0..1 BillingAccount
Tenant 1 --- N Subscription
Project 1 --- N Session

ControlPrincipal 1 --- N RoleBinding
ControlPrincipal 1 --- N AuditEvent

Provider 1 --- N Channel
Provider 1 --- N Credential
Channel N --- 0..1 Credential (same Provider only)

Plan 1 --- N PlanVersion
PlanVersion 1 --- N Subscription
Subscription N --- 1 Tenant
Subscription N --- 1 PlanVersion
CommercialPolicy 1 --- 1 active Subscription projection

Session 1 --- 1 SessionBinding
Session 1 --- N Execution
Session 1 --- N UsageEvent
Session 1 --- N UsageCounter
Session 1 --- 0..1 attached active Reservation
Execution 1 --- N Event
Execution 1 --- N Artifact
UsageEvent 1 --- 1 UsageSettlement
UsageEvent 1 --- 0..N LedgerEntry
PriceRule 1 --- 0..N UsageSettlement
Reservation 1 --- 0..N customer LedgerEntry
```

## 8. Invariants

1. Every authenticated Data Plane request has one Tenant context.
2. Cross-Tenant Session access is impossible; Project-scoped keys also cannot cross Project boundaries.
3. Public Session ID is gateway-owned and distinct from provider-native identity by architecture.
4. SessionBinding selects one Channel and is never silently replaced by health/routing changes.
5. A billed Session persists `creating` binding and reserves capacity before upstream Session creation.
6. Financial admission failure prevents upstream Provider work.
7. Once Provider work may have started, ambiguous local failure does not automatically discard financial exposure or idempotency protection.
8. Provider/Channel plaintext configuration contains no credential material.
9. Channel may reference only a Credential owned by the same Provider.
10. Credential master keys are external runtime secrets.
11. Routing is evaluated for new Sessions, not every event of an existing Session.
12. PlanVersion is immutable.
13. Subscription Tenant, PlanVersion, and start time are immutable.
14. A Tenant has no overlapping scheduled/active subscription intervals.
15. Subscription always references one exact PlanVersion, never a moving latest version.
16. Plan RPM/concurrency are runtime contract overrides; missing values fall back to environment defaults.
17. Caller-explicit Session budget wins over Plan default budget.
18. Existing Session budget does not change when Subscription/Plan changes later.
19. Included-credit entitlement is not spendable until CreditBucket/Ledger materialization exists.
20. UsageEvent and LedgerEntry are append-only; UsageSettlement is separate mutable processing state.
21. Provider corrections append adjustments instead of rewriting usage/ledger history.
22. Price changes affect future settlement only according to effective-time rules.
23. UsageCounter serializes cumulative observations and never accepts an older provider watermark.
24. Outstanding Reservation exposure equals the unconsumed hold; Ledger spend is not double-counted.
25. Before additional billed Agent work, current provider usage is reconciled and remaining SessionBudget evaluated.
26. Successful upstream mutation is not turned into a retryable client failure solely by best-effort post-operation accounting failure.
27. Authorization runs before governed mutation; global resources require global authorization.
28. RBAC management cannot be elevated through a Tenant-scoped role.
29. Authenticated denials and governed mutation outcomes produce AuditEvents.
30. AuditEvent is append-only and contains no secret material.
31. Control Plane request id correlates API operation with audit evidence.
32. Commercial contracts/policy never rewrite immutable financial history.
