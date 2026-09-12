# AGENTS.md

## Mission

Build a product-neutral **Agent API Gateway**: an open-source gateway and SaaS control plane for routing, governing, metering and billing stateful agent executions across heterogeneous agent runtimes.

No caller product is part of this repository's domain model. No single provider is the architecture.

## Core ontology

The central runtime chain is:

```text
Tenant -> Project -> VirtualKey -> Session -> Execution
                                 -> Channel -> Provider
                                            -> Credential
Session -> Usage -> Cost -> Reservation -> Ledger
```

`Session + Execution + Billing` is the architecture core.

## Non-negotiable architecture rules

- Data Plane and Control Plane are separate concepts even when temporarily served by one process.
- The public session ID is always gateway-owned and stable (`agsess_*`). Never expose a provider session ID as the routing identity.
- A created session is pinned to one Channel. Every subsequent event, read and stream must resolve through that binding.
- Provider, Channel and Credential are different entities. Provider is adapter identity; Channel is a routable instance; Credential is secret material.
- A disabled/open-circuit Channel may be excluded from new Session routing but must remain resolvable for Sessions already bound to it.
- Product code must never import provider SDKs directly.
- Provider-specific translation stays inside provider packages.
- Provider type -> plugin-module resolution is trusted server configuration. Never allow a database row or external API payload to import an arbitrary module path.
- Required capabilities must never be silently degraded.
- Native and emulated capabilities must be distinguishable.
- Provider secrets must be stored through Credential resources, never plaintext Provider/Channel config.
- Credential master encryption keys must stay outside Postgres and must never appear in API responses, logs, traces or audit payloads.
- Credential rotation must retain old decrypt keys until all affected Credentials have been rewrapped and verified.
- Tenant isolation is mandatory on every session lookup and mutation.
- Every production mutation must support idempotency.
- Streaming/event semantics are protocol behavior, not UI behavior.
- Usage is not the ledger. Provider usage may be delayed or corrected; billing must support reconciliation.
- Budget enforcement must reserve capacity before execution instead of relying only on after-the-fact charging.
- Never make a live session silently jump providers or channels. Migration is explicit and has lineage + declared semantic loss.

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

- Postgres is the durable source of truth for identity, Provider/Channel/Credential configuration, SessionBindings, idempotency and future financial records.
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
5. `docs/provider-plugin.md` when provider/channel contracts change.
6. `docs/credentials.md` when Provider/Channel/Credential storage, encryption or rotation changes.
7. `CHANGELOG.md` for every externally meaningful change.

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
