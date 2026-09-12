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

The immutable routing relationship established when a Session is created:

```text
Session -> Provider -> Channel -> ProviderSessionId
```

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

## 5. Metering and finance domain

### UsageEvent

An append-only measured fact: model tokens, sandbox duration, tool invocation, storage, search call or provider-specific unit.

UsageEvent may be provisional or final.

### PriceRule

Maps a UsageEvent to monetary price for a particular party and effective time range.

### Cost

What the gateway owes an upstream provider for measured usage.

### Charge

What a customer owes the gateway. Cost and Charge are not required to be equal.

### Reservation

Temporarily locks customer spend capacity before uncertain long-running execution occurs.

### Settlement

Converts provisional usage/reservations into monetary events.

### LedgerEntry

Immutable financial record. Historical LedgerEntries are never recomputed when a PriceRule changes.

### Reconciliation

Compares later provider truth with provisional measurements and emits adjustment LedgerEntries rather than mutating history.

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
Execution 1 --- N Event
Execution 1 --- N Artifact
Session 1 --- 0..N Reservation
UsageEvent N --- 1..N LedgerEntry (through settlement/adjustment)
```

## 8. Invariants

1. Every authenticated Data Plane request has one Tenant context.
2. A Session cannot be read or mutated from another Tenant context.
3. Public Session ID never equals the provider-native session ID by architectural requirement.
4. A SessionBinding is created once for normal execution and is not silently replaced.
5. A Channel belongs to exactly one Provider.
6. A Credential belongs to exactly one Provider, and a Channel may reference only a Credential owned by that same Provider.
7. Provider/Channel plaintext configuration contains no credential material; provider secrets are represented as Credential payloads.
8. Credential master encryption keys are external runtime secrets, never database records or API resources.
9. Routing is evaluated for new Sessions, not every event of an existing Session.
10. Disabling/open-circuiting a Channel affects new routing but never silently moves a bound Session.
11. UsageEvent is append-only evidence; LedgerEntry is immutable financial truth.
12. Reconciliation appends adjustments instead of rewriting historical ledger entries.
13. Price changes affect future settlement according to effective-time semantics; they do not rewrite past invoices.
14. Budget enforcement may reject new work even when the last settled charge is below the budget because outstanding Reservations count against available capacity.
15. Cross-provider or cross-Channel session movement is represented as explicit migration/lineage, never hidden rerouting.
16. A persisted ControlPrincipal secret is represented only by a hash/prefix; plaintext is returned once and is not recoverable from Postgres.
17. Authorization decisions are permission-based and run before the governed resource mutation.
18. Tenant-scoped RoleBindings cannot authorize global-only resources or RBAC management.
19. RBAC management requires a global permission path; a tenant-scoped identity cannot elevate itself globally.
20. Authenticated Control Plane authorization denials produce AuditEvents.
21. AuditEvent is append-only and cannot be updated or deleted through the application or ordinary database row mutation.
22. Secret material must never be copied into AuditEvent metadata.
23. A Control Plane request id correlates the API operation with its AuditEvent.
