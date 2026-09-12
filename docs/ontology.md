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

A caller credential issued by the gateway.

A VirtualKey resolves to exactly one Tenant and may resolve to one Project.

## 2. Runtime supply domain

### Provider

A type of upstream agent runtime implementation.

Examples: `openai-agents`, future `claude-agent`, future self-hosted harness adapters.

Provider is semantic/technical identity, not a credential.

### Channel

A routable provider instance/configuration.

A Channel belongs to exactly one Provider and carries endpoint/credential/capacity/policy metadata.

A Provider may have zero or many Channels.

### Capability

A runtime feature such as sandbox, streaming, MCP, tools, artifacts or subagents.

A Channel inherits provider capabilities and may further constrain them.

## 3. Runtime demand domain

### Session

Gateway-owned durable conversation/execution identity.

A Session belongs to exactly one Tenant and may belong to one Project.

Its external identity is gateway-owned (`agsess_*`).

### SessionBinding

The immutable routing relationship established when a Session is created:

```text
Session -> Provider -> Channel -> ProviderSessionId
```

Normal session traffic never replaces this binding.

### Execution

A bounded period of work inside a Session. A Session may contain many Executions/turns.

Execution is the natural unit for latency, iteration and tool-level traces even when a provider only exposes aggregate session usage.

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

What a customer owes the gateway.

Cost and Charge are not required to be equal.

### Reservation

Temporarily locks customer spend capacity before uncertain long-running execution occurs.

### Settlement

Converts provisional usage/reservations into monetary events.

### LedgerEntry

Immutable financial record. Historical LedgerEntries are never recomputed when a PriceRule changes.

### Reconciliation

Compares later provider truth with provisional measurements and emits adjustment LedgerEntries rather than mutating history.

## 6. Observability domain

### Trace

Correlates requests, executions, provider calls, tools and usage.

### AuditEvent

Records security/administrative mutations such as key creation, channel credential changes, price changes or manual balance adjustments.

## 7. Critical relations

```text
Tenant 1 --- N Project
Tenant 1 --- N VirtualKey
Tenant 1 --- N Session
Project 1 --- N Session
Provider 1 --- N Channel
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
5. A Channel belongs to one Provider.
6. Provider credentials belong to Channels/control-plane secret storage, never callers.
7. Routing is evaluated for new Sessions, not every event of an existing Session.
8. UsageEvent is append-only evidence; LedgerEntry is immutable financial truth.
9. Reconciliation appends adjustments instead of rewriting historical ledger entries.
10. Price changes affect future settlement according to effective-time semantics; they do not rewrite past invoices.
11. Budget enforcement may reject new work even when the last settled charge is below the budget because outstanding Reservations count against available capacity.
12. Cross-provider session movement is represented as explicit migration/lineage, never hidden rerouting.
