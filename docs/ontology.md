# Domain Ontology

This document defines what entities exist, how they relate and which statements must always remain true.

## 1. Identity domain

### Tenant

A commercial/security boundary that owns Projects, Virtual Keys, policies and billing state.

### User

A human identity that may belong to one or more Tenants through Memberships.

### Membership

Relates a User to a Tenant with one or more roles.

### Project

A namespace inside a Tenant. Sessions and Virtual Keys may be scoped to a Project.

### VirtualKey

A caller credential issued by the gateway. A VirtualKey resolves to exactly one Tenant and may resolve to one Project.

A Project-scoped VirtualKey can access only Sessions in the same Project. A Tenant-level VirtualKey may access Sessions across Projects inside that Tenant.

### ControlPrincipal

A durable Control Plane operator or service identity.

A ControlPrincipal authenticates with a one-time `agcp_*` bearer secret. The plaintext secret is returned only at creation time; the durable record stores only a SHA-256 hash and display prefix.

The environment bootstrap administrator is represented at runtime as a synthetic ControlPrincipal-like actor but is not persisted as a normal database Principal.

### RoleBinding

Relates a ControlPrincipal to a built-in Role within an explicit scope.

A RoleBinding has:

- one ControlPrincipal
- one Role (`owner`, `admin`, `operator`, `viewer`)
- one scope type (`global` or `tenant`)
- an optional Tenant scope id when the scope type is `tenant`

Role names are policy bundles; authorization decisions are expressed in Permissions.

### Permission

A stable Control Plane capability such as `channels.write`, `credentials.rewrap`, `rbac.manage`, or `audit.read`.

Global resources require global permission. Tenant-scoped bindings may satisfy a permission only when the operation carries the matching Tenant scope.

## 2. Runtime supply domain

### Provider

A type of upstream agent runtime implementation.

Examples: `openai-agents`, future `claude-agent`, future self-hosted harness adapters.

Provider is semantic/technical adapter identity. It is not a routable account and does not contain provider secrets.

### Credential

Encrypted secret material used to authenticate or authorize calls to one Provider.

A Credential belongs to exactly one Provider. It may contain API keys, tokens or other provider-native authentication fields. Its plaintext payload exists only inside the narrow provider execution boundary.

Credential encryption metadata is durable; master decryption keys are external runtime secrets and are not ontology-owned database records.

### Channel

A routable Provider instance/configuration.

A Channel belongs to exactly one Provider and may reference one Credential belonging to that same Provider. It carries non-secret endpoint/configuration metadata, priority/weight and enabled state.

A Provider may have zero or many Channels. A Credential may be reused by multiple Channels of the same Provider.

### Capability

A runtime feature such as sandbox, streaming, MCP, tools, artifacts or subagents.

A Channel inherits Provider capabilities and may further constrain them.

## 3. Runtime demand domain

### Session

Gateway-owned durable conversation/execution identity.

A Session belongs to exactly one Tenant and may belong to one Project. Its external identity is gateway-owned (`agsess_*`).

### SessionBinding

The routing relationship established when a Session is created:

```text
Session -> Provider -> Channel -> ProviderSessionId
```

The selected Channel is durably recorded while the binding is still `creating`, before the Provider Session is created.

Normal session traffic never replaces this binding.

A Channel becoming disabled, unhealthy or open-circuit does not rewrite an existing SessionBinding.

### Execution

A bounded period of work inside a Session. A Session may contain many Executions/turns.

Execution is the natural unit for latency, iteration and tool-level traces even when a provider only exposes aggregate Session usage.

### Event

An input or output occurrence associated with a Session/Execution: message, tool call/result, approval, artifact, environment event, cancellation or provider-native event.

### Environment

The execution environment used by an agent: none, provider-hosted sandbox or external runtime.

### Artifact

A durable output produced by an Execution such as a file, patch, report or build artifact.

## 4. Policy domain

### RoutingPolicy

Determines which Channels are eligible for a new Session.

### Quota

A cumulative allowance over a period: requests, tokens, sessions, compute, cost, etc.

### RateLimit

A throughput constraint over a short time window.

### ConcurrencyLimit

A maximum number of simultaneously active Sessions/Executions.

### SessionBudget

A hard or soft upper bound attached to a Session, for example max cost, duration, iterations or subagents.

`max_cost_usd` is the first hard-enforced financial SessionBudget dimension.

## 5. Metering and finance domain

### BillingAccount

The Tenant-level financial account that activates billed execution and defines currency, enabled state and credit capacity.

A Tenant without a BillingAccount is currently treated as unbilled. A Tenant with an enabled BillingAccount must pass financial admission before new provider work is authorized.

### UsageEvent

An append-only measured fact: model tokens, sandbox duration, tool invocation, storage, search call or provider-specific unit.

UsageEvent stores a **delta**, even when the upstream Provider reports cumulative usage.

UsageEvent may be provisional, final or an adjustment. Provider corrections append negative adjustment UsageEvents rather than rewriting older facts.

### UsageCounter

The durable cumulative watermark for one Session + usage metric.

It serializes concurrent observations, remembers the latest provider-measured time, and prevents stale cumulative snapshots from moving financial state backward.

### UsageSettlement

Mutable processing state associated with one immutable UsageEvent.

It records whether the event has no applicable price yet or has been settled using a specific PriceRule. Separating this state allows later pricing/reconciliation without modifying UsageEvent evidence.

### PriceRule

Maps a UsageEvent metric to upstream cost and/or customer price for a particular effective time range and optional Tenant/Provider/model dimensions.

### Cost

What the gateway owes an upstream provider for measured usage.

### Charge

What a customer owes the gateway. Cost and Charge are not required to be equal.

### Reservation

Locks customer spend capacity before uncertain long-running execution occurs.

A billed Session has at most one attached active Reservation in the current implementation. Reservation amount represents the maximum authorized spend for that Session; `consumed_micros` tracks the customer charge already represented in the Ledger.

Only the unconsumed part remains an outstanding hold.

### Settlement

The process that converts a UsageEvent under an effective PriceRule into upstream/customer LedgerEntries and consumes the Session Reservation.

### LedgerEntry

Immutable financial record. Historical LedgerEntries are never recomputed when a PriceRule changes.

Every usage-derived LedgerEntry carries the price snapshot used to create it.

### Reconciliation

Compares later provider cumulative truth with the durable UsageCounter and emits adjustment UsageEvents/LedgerEntries rather than mutating history.

## 6. Observability and governance domain

### Trace

Correlates requests, executions, provider calls, tools and usage.

### AuditEvent

An append-only security/administrative fact describing a Control Plane action.

An AuditEvent records:

- actor identity
- request id
- action
- resource type and optional resource id
- optional Tenant scope
- outcome (`success`, `denied`, `error`)
- non-secret metadata
- creation time

AuditEvent is not a general application log. It is durable governance evidence and may not contain bearer tokens, Virtual Key secrets, Credential payloads, ciphertext, master encryption keys, or decrypted provider secrets.

Authenticated permission denials are AuditEvents even though no resource mutation occurred.

## 7. Critical relations

```text
Tenant 1 --- N Project
Tenant 1 --- N VirtualKey
Tenant 1 --- N Session
Tenant 1 --- 0..1 BillingAccount
Project 1 --- N Session

ControlPrincipal 1 --- N RoleBinding
RoleBinding N --- 1 Role
RoleBinding N --- 1 Scope
ControlPrincipal 1 --- N AuditEvent

Provider 1 --- N Channel
Provider 1 --- N Credential
Channel N --- 0..1 Credential (same Provider only)

Session 1 --- 1 SessionBinding
Session 1 --- N Execution
Session 1 --- N UsageEvent
Session 1 --- N UsageCounter
Session 1 --- 0..1 attached Reservation
Execution 1 --- N Event
Execution 1 --- N Artifact
UsageEvent 1 --- 1 UsageSettlement
UsageEvent 1 --- 0..N LedgerEntry
PriceRule 1 --- 0..N UsageSettlement
Reservation 1 --- 0..N customer LedgerEntry
```

## 8. Invariants

1. Every authenticated Data Plane request has one Tenant context.
2. A Session cannot be read or mutated from another Tenant context.
3. A Project-scoped VirtualKey cannot access a Session from another Project, even inside the same Tenant.
4. Public Session ID never equals the provider-native session ID by architectural requirement.
5. A SessionBinding selects one Channel for normal execution and is not silently replaced.
6. A billed Session persists its `creating` SessionBinding and reserves customer capacity before upstream Session creation.
7. Financial admission failure prevents the Provider Session call.
8. A Channel belongs to exactly one Provider.
9. A Credential belongs to exactly one Provider, and a Channel may reference only a Credential owned by that same Provider.
10. Provider/Channel plaintext configuration contains no credential material; provider secrets are represented as Credential payloads.
11. Credential master encryption keys are external runtime secrets, never database records or API resources.
12. Routing is evaluated for new Sessions, not every event of an existing Session.
13. Disabling/open-circuiting a Channel affects new routing but never silently moves a bound Session.
14. UsageEvent is append-only evidence; UsageSettlement is separate mutable processing state; LedgerEntry is immutable financial truth.
15. Reconciliation appends adjustment UsageEvents/LedgerEntries instead of rewriting historical usage or ledger entries.
16. Price changes affect future settlement according to effective-time semantics; they do not rewrite historical price snapshots.
17. A UsageCounter serializes concurrent cumulative observations for one Session + metric and does not accept a provider measurement older than its watermark.
18. Outstanding Reservation exposure equals the unconsumed hold; spend already represented in the Ledger is not double-counted as a full Reservation.
19. Before additional billed Agent work, current cumulative provider usage is reconciled and remaining SessionBudget is evaluated.
20. A successful upstream mutation is not converted into a client-visible failure solely because best-effort post-operation accounting refresh failed; the next expensive operation reconciles strictly before admission.
21. Cross-provider or cross-Channel session movement is represented as explicit migration/lineage, never hidden rerouting.
22. A persisted ControlPrincipal secret is represented only by a hash/prefix; plaintext is returned once and is not recoverable from Postgres.
23. Authorization decisions are permission-based and run before the governed resource mutation.
24. Tenant-scoped RoleBindings cannot authorize global-only resources or RBAC management.
25. RBAC management requires a global permission path; a tenant-scoped identity cannot elevate itself globally.
26. Authenticated Control Plane authorization denials produce AuditEvents.
27. AuditEvent is append-only and cannot be updated or deleted through the application or ordinary database row mutation.
28. Secret material must never be copied into AuditEvent metadata.
29. A Control Plane request id correlates the API operation with its AuditEvent.