# Persistence

## Purpose

Postgres is the durable source of truth for identity, runtime supply configuration and Session routing. Redis accelerates operational hot paths but a Redis loss must not destroy tenant ownership, Channel configuration, Session Affinity or financial truth.

The durable implementation lives in `@agent-gateway/storage-postgres`.

## Durable resources implemented now

```text
gateway_tenants
gateway_projects
gateway_virtual_keys
gateway_providers
gateway_credentials
gateway_channels
gateway_sessions
gateway_idempotency
```

Future RBAC, usage, pricing, reservation, ledger and audit resources extend these ownership boundaries rather than replacing them.

## Virtual Key storage

A Virtual Key has two identities:

```text
secret shown to caller:  ag_...
record id:               vk_...
```

The durable table stores Tenant/Project ownership, SHA-256 secret hash, short display prefix, enabled state and optional expiry. Plaintext is returned only when a key is created and is not recoverable from Postgres.

## Provider / Credential / Channel storage

`gateway_providers` stores Provider type, display metadata, enabled state and non-secret config.

`gateway_credentials` stores Provider ownership, secret kind/name, encrypted payload, encryption-key id and algorithm. The encrypted payload is internal storage data and is redacted from normal Control Plane responses.

`gateway_channels` stores Provider ownership, optional Credential reference, non-secret config, enabled state, priority and weight.

The database enforces:

```text
Channel.provider_id == Credential.provider_id
```

for every Channel that references a Credential. This prevents accidentally attaching one Provider's secret to another Provider.

Master Credential encryption keys are deliberately outside Postgres. See `credentials.md`.

## Session Directory lifecycle

A SessionBinding is written before the upstream Session is created:

```text
allocate agsess_...
select Channel
persist state=creating + Channel
        |
        v
create upstream Session
   |                 |
 success           error
   |                 |
state=bound       state=failed
provider_session  last_error
```

This preserves the routing decision even when provider creation fails. Once bound, all later operations resolve the stored Channel and provider-native Session ID.

Channel configuration can be reloaded while retaining the same Channel ID. Existing Sessions are never silently re-routed because a Channel is disabled or unhealthy.

## Runtime configuration loading

With Postgres enabled, the server loads runtime Channels from durable records:

```text
Provider row
+ Channel row
+ encrypted Credential row
        |
        v
trusted Provider plugin lookup
        |
Credential decrypt in memory
        |
Provider adapter instance
        |
Channel registered under stable id
```

Provider plugin module paths are not stored as untrusted database data. Provider type is mapped through a trusted server-side catalog.

## Idempotency

Session creation accepts `Idempotency-Key`.

Durable scope:

```text
Tenant + VirtualKey + operation scope + Idempotency-Key
```

The record stores a canonical SHA-256 request fingerprint including gateway routing hints.

Outcomes:

- first request: claim `pending`
- same key + same fingerprint while pending: conflict/in-progress
- same key + different fingerprint: conflict
- completed request: replay stored HTTP status/body
- expired record: claim may be reused

The gateway keeps failed/ambiguous upstream creation claims pending until pending TTL expiry. Immediately retrying an ambiguous network failure could create duplicate upstream Sessions.

## Redis interaction

Redis stores only reconstructable/lease-based data:

- hot Session cache
- rate windows
- concurrency leases
- circuit state

A cache miss falls back to Postgres. Redis does not store Credential truth, SessionBinding truth or future Ledger truth.

## Migrations

Schema bootstrap currently uses idempotent `CREATE TABLE/INDEX IF NOT EXISTS` statements in the storage package.

Development may auto-migrate. Production must make migration ownership explicit. A versioned migration framework should be introduced before destructive or transformative schema changes are required.

## Development bootstrap

Development may seed:

```text
tenant_dev
project_dev
vk_dev / ag_dev_local
Provider: mock
Channel:  mock-default
```

If `OPENAI_API_KEY` is present, bootstrap creates an OpenAI Provider, encrypts the API key into a Credential record, and persists `openai-default` as a Channel.

`AGENT_GATEWAY_DEV_BOOTSTRAP=true` is rejected in production.

## In-memory fallback

When `DATABASE_URL` is absent outside production, the server can use in-memory Session/idempotency stores and legacy static Channel configuration.

This exists for adapter development and tests. It is not a SaaS deployment mode.
