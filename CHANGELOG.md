# Changelog

## Unreleased

### Redis runtime controls

- Added `@agent-gateway/runtime-redis` for operational hot-path state.
- Added fixed-window request rate limiting per Virtual Key using atomic Redis Lua operations.
- Added concurrency leases with ZSET expiry, explicit release and heartbeat renewal for long-running streams/tasks.
- Added read-through/write-through Session cache while preserving Postgres as the durable source of truth.
- Added Channel circuit-breaker failure windows and open TTLs.
- Open circuits affect only new Session routing; existing Session Bindings remain pinned to their original Channel.
- Added `429` admission responses with `Retry-After` and limit-type metadata.
- Added Redis to Docker Compose and GitHub Actions integration tests.
- Added a core regression test covering circuit-breaker routing without violating Session Affinity.

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
