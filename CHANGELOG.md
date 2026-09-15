# Changelog

## 0.7.0 - 2026-09-15

### Plans and subscriptions

- Added `@agent-gateway/commercial-postgres` with durable Plan, immutable PlanVersion, Subscription, and resolved CommercialPolicy resources.
- PlanVersion snapshots recurring price, included-credit entitlement, default Session budget, RPM, concurrency and extensible entitlements using exact money micros.
- PlanVersion UPDATE/DELETE is rejected at the database layer.
- Subscription commercial identity (`Tenant + PlanVersion + starts_at`) is immutable and overlapping active/scheduled subscription periods are rejected.
- Active subscriptions resolve one durable runtime CommercialPolicy without following a moving "latest Plan" pointer.

### Commercial Control Plane

- Added governed Plan / PlanVersion / Subscription / current-policy APIs under `/api/gateway/admin/commercial/*`.
- Plan resources are global; Subscription and policy operations support Tenant scope.
- Commercial mutations reuse Control Plane `Idempotency-Key`, encrypted replay, AuditEvent, and shared Postgres transaction guarantees.

### Data Plane commercial policy

- Active PlanVersion `requests_per_minute` and `max_concurrency` now override environment fallback admission values for that Tenant.
- Active PlanVersion `default_session_budget_micros` supplies a hard Session budget when the caller omits `X-Agent-Gateway-Max-Cost-USD`.
- A caller-explicit Session budget remains authoritative when present.
- The effective budget participates in Session-create idempotency and is persisted with the Session, so later Plan/subscription changes do not rewrite an existing Session budget.

### Included-credit boundary

- `included_credit_micros` is persisted as a commercial entitlement snapshot only; it is not treated as a mutable wallet balance or spendable credit yet.
- The next financial layer will materialize period-scoped CreditBuckets backed by immutable Ledger entries and explicit expiry/consumption allocation.

### Validation

- Added real Postgres tests for immutable PlanVersion terms, subscription overlap rejection, cancellation, and runtime policy resolution.
- Added runtime helper tests for Plan quota overrides, environment fallbacks, and explicit-vs-default Session budget precedence.
- Existing Postgres 17 + Redis 7, Data Plane billing, immutable Usage/Ledger, RBAC/Audit and Session Affinity suites remain release gates.

## 0.6.0 - 2026-09-14

### Billing Control Plane

- Added governed Billing management under `/api/gateway/admin/billing/*`.
- Added BillingAccount read/upsert and live exposure reporting for ledger balance, active Reservation holds and available capacity.
- Added effective-dated PriceRule list/create APIs; PriceRules remain append-oriented so historical settlement snapshots are never rewritten.
- Added explicit credit grants backed by immutable customer Ledger entries.
- Added audited UsageEvent, LedgerEntry and Reservation query APIs.

### Financial authorization

- Added explicit billing-domain permissions for account, pricing, credit, usage, ledger and Reservation operations.
- `owner` and `admin` may perform billing/policy writes.
- `operator` and `viewer` are billing read-only.
- Tenant-scoped RoleBindings authorize only the matching Tenant.
- Global PriceRule operations and cross-Tenant/unfiltered financial reads require a global binding.

### Transaction, idempotency and audit

- Every billing mutation requires `Idempotency-Key`.
- Billing mutation, success AuditEvent and encrypted idempotency completion share the existing Control Plane Postgres transaction.
- Failed financial mutations roll back before a separate error AuditEvent is appended.
- Completed billing replays do not execute the financial mutation again and create current-request audit evidence.
- Financial request bodies use exact integer micros strings; no floating-point money inputs are accepted.
- Credit Ledger idempotency is scoped by actor + billing action + Tenant + management key.

### Validation

- Added Billing RBAC scope tests covering global vs Tenant bindings and write vs read-only roles.
- Added real Postgres tests proving BillingAccount mutation and success AuditEvent commit/rollback atomically.
- Existing Data Plane billing, immutable Usage/Ledger, RBAC/Audit, Postgres 17 and Redis 7 suites remain release gates.

## 0.5.0 - 2026-09-13

### Financial foundation

- Added `@agent-gateway/billing-postgres` with durable BillingAccount, effective-dated PriceRule, immutable UsageEvent, UsageSettlement, UsageCounter, Reservation and immutable LedgerEntry resources.
- Money is stored as integer USD micros / exact database numerics rather than JavaScript floating-point ledger values.
- Provider cumulative usage is converted into Session + metric deltas; repeated snapshots do not double-charge.
- Added provider measurement watermarks so stale/out-of-order cumulative snapshots cannot move billing state backward.
- Provider corrections create negative adjustment UsageEvents and refund/adjustment LedgerEntries rather than rewriting history.
- PriceRule snapshots are persisted on LedgerEntries so future pricing changes cannot rewrite historical charges.
- Reservation admission serializes against the Tenant BillingAccount and prevents concurrent Sessions from spending the same available capacity.
- Only the unconsumed Reservation amount remains held, avoiding double-counting customer spend already represented in the Ledger.

### Data Plane billing runtime

- Added `@agent-gateway/billing-runtime` as the lifecycle boundary between Agent Sessions and billing persistence.
- A Tenant with a BillingAccount requires a positive hard Session max-cost budget before new billed Session creation.
- The northbound decimal max-cost header is normalized directly into exact integer micros without JavaScript floating-point conversion.
- Billed Session capacity is reserved and attached to the durable `agsess_*` record before the upstream Provider is contacted.
- A Reservation is released automatically only for failures known to occur before Provider invocation; ambiguous post-provider failures retain the financial hold until reconciliation/expiry handling.
- Added strict preflight usage refresh, settlement, customer-pricing validation, renewable Reservation admission and SessionBudget enforcement before `POST /events` and event streaming.
- Added per-Session exclusive runtime leases so overlapping Agent work cannot both pass the same budget snapshot.
- Added best-effort post-provider usage reconciliation so a successful upstream mutation is not misreported as failed solely because local accounting refresh failed.
- Added HTTP 402 billing-capacity / budget-required / billing-disabled responses, HTTP 429 hard SessionBudget responses, and fail-closed unresolved-pricing responses.
- Added Project-level Session isolation for Project-scoped Virtual Keys while retaining Tenant-wide access for Tenant-level keys.
- Session-create idempotency claims are released only for failures known to occur before Provider work; potentially side-effecting failures remain pending to prevent duplicate Sessions/spend.

### Validation

- Added real Postgres tests for concurrent Reservation admission, cumulative usage deduplication, first-observation concurrency, stale snapshot rejection, provider corrections, price snapshots and immutable Usage/Ledger history.
- Added billing-runtime lifecycle tests for exact-micros budgets, pre-provider Reservation, ambiguous hold retention, billed-budget requirement, unbilled compatibility, unresolved pricing and renewable Reservation capacity.
- Shared-Postgres integration suites run serially to avoid test-only DDL races.
- Existing Postgres 17 + Redis 7 CI remains the release gate.

### Known boundary

- Provider SSE streams are currently opaque bytes, so v0.5/v0.6 enforce budget before stream admission and reconcile cumulative provider usage after stream completion. Precise mid-stream cutoff requires incremental provider usage observability.

## 0.4.1 - 2026-09-12

### Control Plane correctness hardening

- Control Plane resource mutations and their success AuditEvents now commit atomically in one Postgres transaction.
- Added actor-scoped Control Plane `Idempotency-Key` persistence for management mutations.
- Idempotency responses that may contain one-time secrets are encrypted before durable replay storage.
- Principal and Virtual Key creation can safely replay the original one-time secret response after a lost response/retry.
- Mutation failures roll back the resource, success audit, and idempotency completion together; pending idempotency claims are released after rollback.
- Control Plane error responses preserve the same `X-Request-Id` used by authorization-denial and mutation-error AuditEvents.
- Split the Control Plane HTTP implementation out of the Data Plane server entrypoint so RBAC, audit, transaction and idempotency semantics have one explicit boundary.
- Runtime-registry reload happens only after the durable Control Plane transaction commits.

### Validation

- Added Postgres coverage proving an external gateway-resource mutation and AuditEvent roll back/commit together through the shared transaction context.
- Added actor-scoped Control Plane idempotency claim/replay/conflict coverage.
- Existing append-only Audit, RBAC, credential, Postgres, Redis and Session Affinity tests remain part of the release gate.

## 0.4.0 - 2026-09-12

### Control Plane RBAC

- Added `@agent-gateway/control-plane-auth`.
- Added persisted Control Plane Principals with one-time `agcp_...` bearer tokens stored as SHA-256 hashes plus display prefixes.
- Added Role Bindings with built-in `owner`, `admin`, `operator`, and `viewer` roles.
- Added `global` and `tenant` scopes; tenant-scoped bindings apply only to explicitly tenant-scoped resources.
- Restricted RBAC management to the global owner permission path so tenant-scoped identities cannot elevate themselves globally.
- Retained `AGENT_GATEWAY_ADMIN_TOKEN` only as a bootstrap / break-glass global owner identity.
- Added Principal enable/disable and Role Binding management endpoints.

### Audit trail

- Added append-only `gateway_audit_events` persistence.
- Added Postgres triggers rejecting audit `UPDATE` and `DELETE` operations.
- Added audit events for successful Control Plane mutations, authenticated authorization denials, and mutation errors.
- Added audit coverage for sensitive Credential/RBAC/audit reads.
- Added `X-Request-Id` correlation on Control Plane responses and audit events.
- Added filtered audit query endpoint for actor/resource/tenant/outcome investigation.
- Audit metadata intentionally excludes bearer secrets, Virtual Keys, Credential payloads, and decrypted upstream credentials.

### Validation

- Added pure RBAC scope/permission tests.
- Added Postgres integration coverage for Principal authentication and append-only audit enforcement.
- Existing Core, Credential, Postgres, Redis, Session Affinity, and idempotency suites remain part of the release gate.

## 0.3.0 - 2026-09-12

### Runtime controls

- Added `@agent-gateway/runtime-redis` for reconstructable hot-path state.
- Added fixed-window request rate limiting per Virtual Key using atomic Redis operations.
- Added concurrency leases with expiry, explicit release and heartbeat renewal for long-running streams/tasks.
- Added read-through/write-through Session cache while preserving Postgres as the durable source of truth.
- Added Channel circuit-breaker failure windows and open TTLs.
- Open circuits affect only new Session routing; existing SessionBindings remain pinned to their original Channel.
- Added `429` admission responses with `Retry-After` and limit-type metadata.

### Persistent runtime supply

- Added durable `Provider`, `Credential`, and `Channel` resources in Postgres.
- Persistent Channel configuration is the runtime source of truth when Postgres is enabled.
- Added trusted Provider type -> installed plugin mapping; database rows cannot import arbitrary modules.
- Added live runtime-registry rebuild after Provider, Credential, and Channel mutations.
- Disabled Channels remain resolvable for existing bound Sessions while being excluded from new-session routing.
- Added database constraints preventing a Channel from referencing a Credential owned by a different Provider.

### Credential security

- Added `@agent-gateway/credential-crypto`.
- Added AES-256-GCM authenticated encryption for upstream Credential payloads.
- Bound ciphertext to Credential ID and Provider ID through authenticated data.
- Master encryption keys stay outside Postgres and support multiple decrypt keys plus one active encryption key.
- Added Credential master-key rewrap without changing the upstream provider secret.
- Added upstream secret replacement through the Credential resource.
- Redacted encrypted payloads from Control Plane list responses.
- Provider/Channel plaintext config rejects secret-like field names.
- Development OpenAI bootstrap persists `OPENAI_API_KEY` as an encrypted Credential rather than plaintext Channel config.

### Validation

- CI runs real Postgres 17 and Redis 7 services.
- Added Credential encryption/rotation tests.
- Extended Postgres integration coverage for Provider/Credential/Channel persistence, redaction, ownership constraints, Session bindings, and idempotency.
- Added core regression coverage for circuit breaking without violating Session Affinity.

## 0.2.0 - 2026-09-12

### Reframed

- Repositioned the repository as an independent open-source Agent API Gateway / SaaS control plane, not a caller-product integration layer.
- Defined Session + Execution + Billing as the core architecture.

### Architecture

- Split Provider identity from routable Channel identity.
- Added gateway-owned stable `agsess_*` session IDs.
- Added tenant-aware Session Binding and strict session affinity.
- Added Virtual Key authentication context.
- Moved the Data Plane to the OpenAI Agents API-shaped `/agents/sessions` surface.
- Added gateway routing headers for provider/channel/capability/budget policy.
- Added event submission and event streaming through pinned channels.
- Preserved provider-native session fields while rewriting the public session identity.

### Durable SaaS foundation

- Added `@agent-gateway/storage-postgres`.
- Added Postgres-backed Tenant, Project, Virtual Key, Session Directory and idempotency persistence.
- Virtual Key plaintext is not stored in the durable path; only SHA-256 hash and display prefix are persisted.
- Added Session Binding lifecycle states `creating`, `bound`, and `failed` so the selected Channel is durably recorded before the upstream session call.
- Added `Idempotency-Key` support for session creation with canonical request hashing, conflict detection and completed-response replay.
- Added separate pending/completed idempotency TTLs.
- Added bootstrap Control Plane endpoints for creating tenants, projects and virtual keys.
- Added Postgres to the default Docker Compose development stack.
- Added core tests and GitHub Actions build/test validation.

### Documentation

- Added full product specification.
- Added domain ontology and invariants.
- Added Data Plane / Control Plane API specification.
- Added metering, reservation, settlement and reconciliation model.
- Added durable persistence documentation.
- Reworked provider plugin documentation around Provider vs Channel.
- Removed product-specific integration documentation from the gateway domain.

## 0.1.0

- Initial provider-agnostic Agent Runtime Gateway skeleton.
- Added provider registry, OpenAI adapter, mock provider, SDK skeleton and basic session routing.
