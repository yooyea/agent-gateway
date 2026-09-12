# Architecture

## 1. System boundary

Agent Gateway is independent infrastructure between arbitrary callers and heterogeneous agent runtimes.

```text
                         CALLERS
          SaaS / IDE / CI / Internal Platform
                            |
                     Virtual API Key
                            |
                            v
+----------------------------------------------------------+
|                      DATA PLANE                          |
| Auth -> Policy -> Session Router -> Session Affinity     |
|              -> Provider Channel -> Agent Runtime        |
+----------------------------+-----------------------------+
                             |
                events / usage / traces
                             |
+----------------------------v-----------------------------+
|                    CONTROL PLANE                         |
| Tenants / Projects / Keys / RBAC                         |
| Providers / Channels / Credentials / Health              |
| Routing Policies / Quota / Rate / Concurrency            |
| Pricing / Reservation / Usage / Ledger / Reconciliation  |
| Audit / Metrics / Administration                         |
+----------------------------------------------------------+
```

The first implementation serves both planes from one Node process. The boundary is logical and must remain explicit so the planes can be split later.

## 2. Provider, Channel and Credential

`Provider` describes a runtime adapter implementation such as `openai-agents`.

`Channel` is one routable instance of a Provider:

```text
Provider: openai-agents
  |- Channel: openai-account-a -> Credential A
  |- Channel: openai-account-b -> Credential B
  |- Channel: enterprise-x     -> Credential C
```

`Credential` contains encrypted provider authentication material. It belongs to one Provider and may be referenced only by Channels of that Provider.

Provider and Channel configuration is non-secret. Endpoint, default model, priority and weight may be queried normally. API keys/tokens/passwords belong in Credential payloads.

When Postgres is enabled, Provider/Channel/Credential records are the runtime source of truth. The server maps Provider type to a trusted installed plugin, decrypts the Credential in memory, merges Provider + Channel + Credential configuration, and instantiates the adapter.

Database values cannot import arbitrary plugin modules. Trusted module mapping is server/environment configuration.

Control-plane changes rebuild the in-memory ProviderRegistry. Stable Channel IDs preserve SessionBinding resolution across reloads.

## 3. Credential security boundary

Credential payloads are encrypted with AES-256-GCM before durable storage.

```text
Runtime master keyring (env/KMS boundary)
                 |
                 v
        CredentialKeyring
                 |
      encrypt / decrypt / rewrap
                 |
                 v
Postgres: ciphertext + key id + algorithm
```

Master keys never enter Postgres.

Authenticated data binds ciphertext to Credential ID and Provider ID, preventing a ciphertext from being moved to another resource without authentication failure.

Multiple decrypt keys may coexist while one key is active for new encryption. Rotation keeps the old key available until every Credential has been rewrapped to the new active key.

## 4. Session affinity and durable binding

A new request follows:

```text
Create Session
   |
Authenticate Virtual Key -> Tenant / Project
   |
Resolve policy and select eligible Channel
   |
Allocate gateway agsess_...
   |
Persist SessionBinding(state=creating, selected Channel)
   |
Create provider-native session
   |                         |
 success                    failure
   |                         |
Persist provider ID       Persist state=failed
state=bound               + last error
   |
Return agsess_...
```

The binding is conceptually:

```text
agsess_123
  -> tenant_1
  -> provider=openai-agents
  -> channel=openai-account-a
  -> provider_session_id=session_xyz
  -> state=bound
```

Every later operation resolves the binding first. It must not be load-balanced again.

Disabling a Channel or opening its circuit excludes it from new Session routing. It does not remove the Channel from the registry and does not move existing bound Sessions.

## 5. Routing

Routing applies when a new Session is created or when an explicit future migration creates a replacement Session.

Selection pipeline:

1. explicit Channel, if requested
2. Provider constraint
3. tenant/project allow policy
4. required capabilities
5. enabled state
6. circuit/health state
7. rate/concurrency/capacity availability
8. priority tier
9. weighted selection inside the tier
10. optional cost/latency/reliability scoring

## 6. Data Plane

Responsibilities:

- authenticate hashed Virtual Keys
- derive Tenant/Project context
- enforce rate/concurrency/policy
- create gateway Session IDs
- resolve durable SessionBindings
- proxy/map events and streams
- persist idempotency decisions
- emit usage/trace records
- enforce active budget decisions

The Data Plane should avoid administrative joins or analytics on the hot path.

## 7. Control Plane

Responsibilities:

- tenant/user/project lifecycle
- virtual-key lifecycle
- Provider/Channel/Credential lifecycle
- trusted provider-plugin catalog
- routing policy
- quota/budget policy
- pricing / wallet / invoice configuration
- usage reconciliation
- audit and operator workflows

Provider/Channel/Credential mutations currently trigger an in-process registry rebuild. A future distributed Control Plane should publish versioned configuration changes rather than relying on process-local reload.

## 8. Persistence

### Postgres — durable truth

Implemented source of truth:

- tenants / projects
- virtual keys (hash + prefix)
- Providers
- encrypted Credentials + encryption metadata
- Channels
- SessionBindings and binding lifecycle
- idempotency records + replay responses

Future durable domains:

- users / RBAC / memberships
- routing policies
- usage events
- price snapshots
- reservations
- ledger entries
- audit events

### Redis — reconstructable runtime state

Implemented operational state:

- request rate-limit windows
- concurrency leases
- hot Session cache
- Channel circuit state

Redis is never the financial, Credential or Session-affinity source of truth.

### Runtime secret boundary

Credential master encryption keys live outside Postgres/Redis. Environment variables provide the initial implementation; KMS/HSM-backed key material can replace that boundary without changing Credential records.

## 9. Idempotency

Session creation uses `Idempotency-Key` scoped by Tenant + VirtualKey + operation. The fingerprint includes the Data Plane body and routing hints.

A completed request replays the original response. A reused key with a different fingerprint fails. A concurrent request for a pending key fails as in-progress rather than creating a second upstream Session.

## 10. Billing pipeline

```text
Provider/runtime events
        |
        v
Raw Usage Capture
        |
        v
Normalization
        |
        v
Cost Estimation --------> Budget Guard
        |
        v
Provisional Settlement
        |
        v
Provider Reconciliation
        |
        v
Immutable Ledger
```

Provider Session `usage` is evidence, not the ledger itself.

## 11. Reliability

For new Sessions, disabled, unhealthy or circuit-open Channels are skipped.

For an existing Session, Channel failure must not cause transparent rerouting because provider-native state would be lost. The gateway exposes the failure and may later offer explicit migration/recovery.

Runtime-registry rebuilds must preserve Channel IDs. If a persisted Channel required by an existing Session is deleted in the future, deletion semantics must account for active bindings rather than causing an implicit migration.

## 12. Security

- upstream provider Credentials never reach callers
- Provider/Channel config rejects secret-like fields
- Credential ciphertext is authenticated and bound to Credential + Provider identity
- Credential master keys never live in Postgres
- Control Plane Credential responses never return ciphertext or plaintext
- durable Virtual Keys are SHA-256 hashed at rest
- all Data Plane access resolves a Tenant context
- logs/traces must redact caller and provider secrets
- administrative mutations require RBAC + audit in the next Control Plane layer
- development bootstrap secrets are forbidden as a production mechanism

## 13. Extensibility

Provider packages implement a small adapter interface. Core routing knows Channels and capabilities, not vendor SDKs.

A Provider may expose native fields in its Session payload. The gateway rewrites the public Session ID and appends `gateway.provider/channel` metadata rather than flattening every Provider into a lowest-common-denominator object.
