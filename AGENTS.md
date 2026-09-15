# Agent Gateway Engineering Rules

Agent Gateway is an independent Agent API gateway / SaaS infrastructure product. It is not coupled to LineHalo or any other caller product.

## Product boundary

The gateway sits between arbitrary callers and heterogeneous Agent runtimes.

```text
Caller -> Agent Gateway -> Provider Channel -> Agent Runtime
```

Callers integrate with the gateway, not with a specific upstream account. The gateway owns authentication, routing, Session affinity, metering, billing, commercial policy, governance and observability concerns that should not be reimplemented by every product.

## Core domain

The core architecture is centered on:

```text
Session + Execution + Billing
```

Provider model calls are implementation details inside an Agent lifecycle. Do not reduce the product back to an LLM request proxy.

## Provider / Channel rules

- Provider means adapter/runtime type.
- Channel means one routable Provider instance/account/configuration.
- Credentials are separate encrypted resources and never plaintext Provider/Channel config.
- A Channel may reference only a Credential owned by the same Provider.
- Database configuration may select only trusted installed Provider plugins; never load arbitrary module paths from tenant input.
- Provider plugins translate provider-native semantics at the boundary; core routing must not contain vendor-specific SDK logic.

## Session rules

- Public Session IDs are gateway-owned `agsess_*` identifiers.
- Persist the selected Channel before contacting the upstream provider.
- SessionBinding transitions through `creating -> bound | failed`.
- Once bound, every operation returns to the original Channel.
- Circuit breakers, disabled Channels and routing policy affect new Sessions only.
- Never make a live session silently jump providers or channels. Migration is explicit and has lineage + declared semantic loss.
- A Project-scoped Virtual Key may access only Sessions belonging to that same Project. Tenant-level keys may access Sessions across Projects in the Tenant.
- An effective Session budget is persisted at Session creation; later Plan/subscription changes must not retroactively change it.

## Control Plane authorization rules

- `AGENT_GATEWAY_ADMIN_TOKEN` is bootstrap / break-glass access, not the steady-state operator identity model.
- Normal Control Plane access uses persisted Control Principals with one-time bearer secrets stored hashed at rest.
- Authorization is permission-based. HTTP handlers must not hard-code broad role-name checks when a permission can express the decision.
- Role Bindings have explicit scope. Global resources require global authorization; tenant-scoped bindings apply only to operations carrying the matching Tenant scope.
- RBAC management is global-only. A tenant-scoped role must never be able to elevate itself into a global role.
- Authorization must run before the durable resource mutation.
- Authenticated authorization denials must leave audit evidence.
- Sensitive reads such as Credential metadata, RBAC metadata and Audit access should be auditable.
- Control Plane idempotency is scoped by actor + operation + key. Reusing a key with a changed request must fail closed.
- Idempotent replay state that contains one-time secrets must be encrypted at rest; plaintext bearer/Virtual Key secrets must never be stored in replay tables.

## Audit rules

- Audit is append-only. Application code must not expose update/delete operations for Audit Events.
- The database must enforce immutability for audit rows in addition to application conventions.
- Every Control Plane mutation records actor, request id, action, resource, outcome and non-secret metadata.
- A successful Control Plane resource mutation, its success AuditEvent, and its idempotency completion must commit in the same Postgres transaction.
- A failed mutation must roll back the resource and success AuditEvent together; an error AuditEvent may be appended only after rollback.
- Runtime side effects derived from Control Plane state happen after durable commit and must not turn an already-committed mutation into a false retry signal.
- Bearer tokens, Virtual Key plaintext, Credential payloads, ciphertext, master keys and decrypted upstream credentials must never enter audit metadata.
- Every Control Plane response, including failures, must expose the same request id used by its audit evidence.

## Commercial contract rules

- `Plan` is a mutable product identity; `PlanVersion` is an immutable commercial terms snapshot.
- Never update/delete a PlanVersion to change an offer. Create a new version.
- A Subscription pins exactly one Tenant to exactly one PlanVersion; it never follows a moving "latest" Plan version.
- Subscription commercial identity (`Tenant + PlanVersion + starts_at`) is immutable.
- A Tenant must not have overlapping scheduled/active subscription intervals.
- CommercialPolicy is a runtime projection of the active Subscription; it is not financial truth.
- Plan RPM/concurrency override environment fallback limits when present. Missing Plan values use environment defaults.
- A Plan default Session budget applies only when the caller does not explicitly declare one.
- `included_credit_micros` is an entitlement declaration, not a mutable/spendable wallet balance. Spendability begins only when a CreditBucket/Ledger grant is materialized.
- Commercial money values use exact integer micros. JavaScript floating point is never authoritative.

## Data Plane billing rules

- Postgres financial state is authoritative. Redis must never become a balance, Reservation, UsageEvent or Ledger source of truth.
- A Tenant with a BillingAccount is billed. A new billed Session must have a positive hard budget either explicitly supplied by the caller or resolved from active CommercialPolicy.
- A billed Session must persist its `creating` SessionBinding and reserve customer capacity **before** the upstream Provider is contacted.
- If financial admission fails, do not call the Provider.
- Once Provider invocation may have started, do not release a Reservation merely because local binding/provider completion is ambiguous; preserve the financial hold until reconciliation/expiry handling.
- Active Reservation exposure is the unconsumed amount. Spend already represented in the customer Ledger must not also remain fully reserved.
- Before additional Agent work, refresh cumulative provider usage, settle the delta and evaluate remaining SessionBudget before contacting the Provider.
- Usage refresh/budget admission before provider work is fail-closed for billed Sessions.
- Once an upstream mutation has succeeded, post-operation usage reconciliation is best-effort; an accounting-refresh failure must not turn provider success into a false client retry signal.
- The next expensive operation must catch up through strict preflight reconciliation.
- Data Plane idempotency claims may be released only for failures known to occur before an upstream side effect. Potentially side-effecting failures remain pending.
- Long opaque SSE streams currently enforce budget at stream admission and reconcile on completion. Do not claim mid-stream hard-stop precision until provider usage is observable during the stream.

## Financial data rules

- `UsageEvent` is append-only measured evidence.
- `UsageSettlement` stores settlement processing state separately from immutable UsageEvent evidence.
- `LedgerEntry` is immutable financial truth.
- Provider cumulative usage is converted to deltas under a durable Session + metric counter lock.
- UsageCounter keeps a provider measurement watermark; stale/out-of-order observations must not move it backward.
- Provider corrections append negative adjustment UsageEvents and refund/adjustment LedgerEntries instead of rewriting history.
- Effective PriceRules are snapshotted into LedgerEntries. Later price changes never rewrite historical charges.
- Money is stored in integer micros / exact database numeric arithmetic. JavaScript floating point is not a financial source of truth.
- Commercial entitlement state must never rewrite prior UsageEvent or LedgerEntry history.

## Northbound API rule

Prefer an existing provider-compatible Agents API surface over inventing a gateway-specific agent protocol. Gateway-only routing/policy should use headers or the management API unless there is no compatible alternative.

The first compatibility target is OpenAI Agents API:

```text
POST /agents/sessions
GET  /agents/sessions/{session_id}
POST /agents/sessions/{session_id}/events
GET  /agents/sessions/{session_id}/events
```

The gateway may rewrite identifiers and append gateway metadata while preserving provider-native fields.

## Control Plane rule

Gateway management belongs under `/api/gateway/*`. It must not leak into provider-compatible data-plane request bodies.

Control Plane domains include:

- tenants / Control Principals / RBAC
- projects
- virtual keys
- providers / channels / credentials
- routing policies
- quotas / rate limits / concurrency
- plans / plan versions / subscriptions / commercial policy
- budgets / reservations
- pricing / usage / ledger / invoices
- audit / traces / metrics

## Persistence rule

- Postgres is the durable source of truth for identity, RBAC, audit, Provider/Channel/Credential configuration, commercial contracts, SessionBindings, idempotency and financial records.
- Redis contains only reconstructable or lease-based runtime state: cache, rate windows, concurrency leases and circuit state.
- Master Credential encryption keys come from the runtime secret boundary (environment/KMS integration), never Postgres.
- In-memory stores and environment-backed caller keys are development adapters only.

## Secret-handling rule

Provider/Channel config is non-secret and queryable. Secret-like fields such as API keys, access tokens, refresh tokens, passwords, authorization values and client secrets must be rejected from plaintext config and represented as encrypted Credential payloads.

Control-plane Credential responses expose metadata only; they never return ciphertext or decrypted provider secrets.

## Documentation synchronization

When the system changes materially, update the relevant normative documents in the same change:

1. `docs/ontology.md` when entities, relations or invariants change.
2. `docs/architecture.md` when component boundaries or runtime flows change.
3. `docs/api-spec.md` when public or management APIs change.
4. `docs/billing.md` when usage, price, reservation or settlement semantics change.
5. `docs/commercial.md` when Plan/PlanVersion/Subscription/entitlement semantics change.
6. `docs/provider-plugin.md` when provider/channel contracts change.
7. `docs/credentials.md` when Provider/Channel/Credential storage, encryption or rotation changes.
8. `docs/rbac-audit.md` when Control Plane identity, permissions, scopes or audit semantics change.
9. `CHANGELOG.md` for every externally meaningful change.

Code and ontology must not knowingly drift.

## Provider addition checklist

1. Implement the provider contract in `packages/provider-<name>`.
2. Register the provider type in trusted server-side plugin configuration.
3. Declare supported/native/emulated capabilities truthfully.
4. Keep credentials in Credential resources; keep endpoint/non-secret settings in Provider/Channel config.
5. Add provider contract tests.
6. Document semantic differences and unsupported behavior.
7. Verify session affinity, event submission, streaming and usage mapping.
8. Update changelog and architecture docs if the provider requires a new abstraction.
