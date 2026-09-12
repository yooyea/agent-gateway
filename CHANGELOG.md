# Changelog

## 0.4.1 - 2026-09-12

### Control Plane correctness hardening

- Control Plane resource mutations and their success AuditEvents now commit atomically in one Postgres transaction.
- Added actor-scoped Control Plane `Idempotency-Key` persistence for management mutations.
- Idempotency responses that may contain one-time secrets are encrypted before durable replay storage.
- Principal and Virtual Key creation can now safely replay the original one-time secret response after a lost response/retry.
- Mutation failures roll back the resource, success audit, and idempotency completion together; pending idempotency claims are released after rollback.
- Control Plane error responses now preserve the same `X-Request-Id` used by authorization-denial and mutation-error AuditEvents.
- Split the Control Plane HTTP implementation out of the Data Plane server entrypoint so RBAC, audit, transaction and idempotency semantics have one explicit boundary.
- Runtime-registry reload happens only after the durable Control Plane transaction commits, preventing rolled-back Channel/Provider changes from leaking into in-memory routing state.

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
- Persistent Channel configuration is now the runtime source of truth when Postgres is enabled.
- Added trusted Provider type -> installed plugin mapping; database rows cannot import arbitrary modules.
- Added live runtime-registry rebuild after Provider, Credential, and Channel mutations.
- Disabled Channels remain resolvable for existing bound Sessions while being excluded from new-session routing.
- Added database constraints preventing a Channel from referencing a Credential owned by a different Provider.

### Credential security

- Added `@agent-gateway/credential-crypto`.
- Added AES-256-GCM authenticated encryption for upstream Credential payloads.
- Bound ciphertext to Credential + Provider identity through authenticated data.
- Master encryption keys stay outside Postgres and support multiple decrypt keys plus one active encryption key.
- Added Credential master-key rewrap without changing the upstream provider secret.
- Added upstream secret replacement through the Credential resource.
- Redacted encrypted payloads from Control Plane list responses.
- Provider/Channel plaintext config rejects secret-like field names.
- Development OpenAI bootstrap now persists `OPENAI_API_KEY` as an encrypted Credential rather than plaintext Channel config.

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
- Virtual Key plaintext is no longer stored in the durable path; only SHA-256 hash and display prefix are persisted.
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
