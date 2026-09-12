# Persistence

## Purpose

Postgres is the durable source of truth for identity and session routing. Redis may later accelerate hot-path reads, but a Redis loss must not destroy tenant ownership, session affinity or financial truth.

The first durable implementation lives in `@agent-gateway/storage-postgres`.

## Durable resources implemented now

```text
gateway_tenants
gateway_projects
gateway_virtual_keys
gateway_sessions
gateway_idempotency
```

Future billing/provider resources will extend this schema rather than replacing its ownership boundaries.

## Virtual Key storage

A Virtual Key has two identities:

```text
secret shown to caller:  ag_...
record id:               vk_...
```

The durable table stores:

- key record ID
- Tenant / optional Project ownership
- SHA-256 hash of the secret
- short display prefix
- enabled state
- optional expiry

The plaintext secret is returned only when a key is created and must not be recoverable from the database.

Authentication hashes the presented bearer token and performs an indexed lookup. Tenant and Project must both be active.

## Session Directory lifecycle

A Session Binding is written before the upstream session is created:

```text
allocate agsess_...
select Channel
persist state=creating + Channel
        |
        v
create upstream session
   |                 |
 success           error
   |                 |
state=bound       state=failed
provider_session  last_error
```

This preserves the routing decision even if the provider call fails. Once `bound`, all later operations resolve the stored Channel and provider-native session ID. Existing sessions are never silently re-routed.

`provider_session_id` is nullable only while the binding is not yet bound.

## Idempotency

Session creation accepts:

```http
Idempotency-Key: caller-generated-value
```

The durable key scope is:

```text
Tenant + VirtualKey + operation scope + Idempotency-Key
```

The record stores a canonical SHA-256 request fingerprint including gateway routing hints.

Outcomes:

- first request: claim `pending`
- same key + same fingerprint while pending: `409 in progress`
- same key + different fingerprint: `409 conflict`
- completed request: replay the stored HTTP status/body
- expired record: claim may be reused

Pending and completed records use separate TTLs. Pending defaults to 15 minutes; completed replay defaults to 24 hours.

The gateway deliberately keeps a failed/ambiguous upstream creation claim pending until its pending TTL expires. This is conservative: immediately retrying an ambiguous network failure could create two upstream sessions.

## Migrations

The current schema bootstrap is idempotent `CREATE TABLE/INDEX IF NOT EXISTS` SQL executed by the storage package.

Development defaults may auto-migrate. Production must make migration ownership explicit; `AGENT_GATEWAY_AUTO_MIGRATE=true` is required if the application process itself owns schema changes.

A versioned migration framework should be introduced before destructive/transformative schema changes are needed.

## Development bootstrap

With Docker Compose, development may seed:

```text
tenant_dev
project_dev
vk_dev / ag_dev_local
```

`AGENT_GATEWAY_DEV_BOOTSTRAP=true` is rejected in production.

## In-memory fallback

When `DATABASE_URL` is absent outside production, the server can still use in-memory Session and idempotency stores plus static `AGENT_GATEWAY_KEYS`.

This path exists for adapter development and tests. It is not a SaaS deployment mode.
