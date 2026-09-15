# Commercial Plans and Subscriptions

## Purpose

The commercial domain defines what a Tenant has purchased and which runtime entitlements are active. It does not replace Billing/Ledger financial truth.

```text
Plan
  -> immutable PlanVersion
      -> Subscription
          -> CommercialPolicy
              -> Data Plane admission defaults
```

Billing answers what money was reserved, charged, credited, or reconciled. Commercial policy answers which contract terms apply now.

## Plan

`Plan` is the mutable product identity. It has a stable `agplan_*` id, name, description, and active/archived status.

Archiving a Plan prevents new versions/subscriptions from being created against it. Existing historical PlanVersions and subscriptions remain durable.

## PlanVersion

`PlanVersion` is an immutable commercial terms snapshot (`agplanv_*`). Database triggers reject UPDATE and DELETE.

Terms include:

- billing interval (`month` or `year`)
- recurring price in exact USD micros
- included credit entitlement in exact micros
- default Session budget in exact micros
- requests-per-minute quota
- max caller concurrency
- extensible non-secret entitlements JSON
- effective timestamp

A new commercial offer creates a new PlanVersion. Never rewrite an existing version to change historical subscription terms.

## Subscription

A `Subscription` (`agsub_*`) belongs to exactly one Tenant and exactly one PlanVersion.

Commercial identity is immutable:

```text
Tenant + PlanVersion + starts_at
```

A Tenant cannot have overlapping scheduled/active subscription periods. A PlanVersion must already be effective at subscription start.

Canceling a subscription shortens its active interval; it does not mutate the referenced PlanVersion.

## CommercialPolicy

`CommercialPolicy` is a resolved runtime projection for the Tenant's currently active subscription. It includes:

- subscription / Plan / PlanVersion identity
- current subscription period
- included-credit entitlement
- default Session budget
- requests-per-minute
- max concurrency
- entitlements

Postgres is the durable source of truth. The current implementation resolves policy on Data Plane admission; a future Redis cache may accelerate this only as reconstructable state.

## Data Plane enforcement

For every authenticated Data Plane request:

```text
VirtualKey -> Tenant
      |
      v
resolve active CommercialPolicy
      |
      +--> RPM limit (or environment fallback)
      |
      +--> caller concurrency limit (or environment fallback)
      |
      +--> Session-create default max-cost budget
```

Plan RPM/concurrency are contract values and override the environment defaults for a Tenant with an active subscription. The environment values remain fallback policy for Tenants without an applicable plan value.

For new Session creation:

- caller-supplied `X-Agent-Gateway-Max-Cost-USD` is converted to exact micros and wins when present;
- otherwise the active PlanVersion `default_session_budget_micros` is used when present;
- the effective budget participates in Data Plane idempotency fingerprinting and is persisted with the Session;
- later subscription/Plan changes do not retroactively mutate an existing Session budget.

A billed Tenant still needs a hard Session budget. An active subscription with a default budget can satisfy that requirement without forcing every caller to repeat the header.

## Included credits boundary

`included_credit_micros` is currently a commercial entitlement snapshot only. It is **not** a mutable wallet balance and is not yet spendable merely because a PlanVersion declares it.

The next financial layer materializes included credits as period-scoped CreditBuckets backed by immutable Ledger entries. This separation prevents Plan edits or subscription state from silently changing financial history.

## Control Plane

Commercial management lives under:

```text
/api/gateway/admin/commercial/*
```

Current resources:

- Plans
- PlanVersions
- Subscriptions
- resolved Tenant policy

Plan/PlanVersion resources are global. Subscription and policy operations are Tenant-scoped. Commercial writes require `Idempotency-Key`, append Audit evidence, and commit resource mutation + success Audit + encrypted replay completion in the existing Control Plane Postgres transaction.

## Invariants

- PlanVersion is immutable.
- Subscription commercial identity is immutable.
- A Tenant has no overlapping active/scheduled subscription intervals.
- Subscription references one exact PlanVersion, never a moving "latest" Plan.
- Commercial money fields use exact integer micros.
- Commercial policy never mutates immutable Usage/Ledger history.
- Explicit caller Session budget wins over Plan default budget.
- Existing Session budgets are not changed by later Plan/subscription changes.
- Included credit entitlement is not treated as spendable balance until CreditBucket materialization exists.
