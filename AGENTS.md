# AGENTS.md

## Mission

Build a product-neutral **Agent API Gateway**: an open-source gateway and SaaS control plane for routing, governing, metering and billing stateful agent executions across heterogeneous agent runtimes.

No caller product is part of this repository's domain model. No single provider is the architecture.

## Core ontology

The central runtime chain is:

```text
Tenant -> Project -> VirtualKey -> Session -> Execution
                                 -> Channel -> Provider
Session -> Usage -> Cost -> Reservation -> Ledger
```

`Session + Execution + Billing` is the architecture core.

## Non-negotiable architecture rules

- Data Plane and Control Plane are separate concepts even when temporarily served by one process.
- The public session ID is always gateway-owned and stable (`agsess_*`). Never expose a provider session ID as the routing identity.
- A created session is pinned to one channel. Every subsequent event, read and stream must resolve through that binding.
- Provider and Channel are different entities. A provider type may have many credentials/accounts/endpoints represented by many channels.
- Product code must never import provider SDKs directly.
- Provider-specific translation stays inside provider packages.
- Required capabilities must never be silently degraded.
- Native and emulated capabilities must be distinguishable.
- Provider secrets are server-side only.
- Tenant isolation is mandatory on every session lookup and mutation.
- Every production mutation must support idempotency.
- Streaming/event semantics are protocol behavior, not UI behavior.
- Usage is not the ledger. Provider usage may be delayed or corrected; billing must support reconciliation.
- Budget enforcement must reserve capacity before execution instead of relying only on after-the-fact charging.
- Never make a live session silently jump providers. Cross-provider migration is an explicit operation with lineage and declared semantic loss.

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

- tenants / users / RBAC
- projects
- virtual keys
- providers / channels / credentials
- routing policies
- quotas / rate limits / concurrency
- budgets / reservations
- pricing / usage / ledger / invoices
- audit / traces / metrics

## Persistence rule

In-memory stores and environment-backed credentials are development adapters only. Domain services must depend on interfaces so Postgres/Redis implementations can replace them without changing routing semantics.

## Documentation synchronization

When the system changes materially, update the relevant normative documents in the same change:

1. `docs/ontology.md` when entities, relations or invariants change.
2. `docs/architecture.md` when component boundaries or runtime flows change.
3. `docs/api-spec.md` when public or management APIs change.
4. `docs/billing.md` when usage, price, reservation or settlement semantics change.
5. `docs/provider-plugin.md` when provider/channel contracts change.
6. `CHANGELOG.md` for every externally meaningful change.

Code and ontology must not knowingly drift.

## Provider addition checklist

1. Implement the provider contract in `packages/provider-<name>`.
2. Declare supported/native/emulated capabilities truthfully.
3. Add channel configuration support without embedding credentials in callers.
4. Add provider contract tests.
5. Document semantic differences and unsupported behavior.
6. Verify session affinity, event submission, streaming and usage mapping.
7. Update changelog and architecture docs if the provider requires a new abstraction.
