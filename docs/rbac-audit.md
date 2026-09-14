# Control Plane RBAC and Audit

## Purpose

The Control Plane must not depend on one shared administrator bearer token for normal operation.

`AGENT_GATEWAY_ADMIN_TOKEN` remains bootstrap / break-glass access only. Normal operators use persisted Control Plane Principals whose one-time bearer secrets are hashed at rest and authorized through Role Bindings.

## Principal model

```text
Principal
  -> RoleBinding
      -> Role
      -> Scope
      -> Permissions
```

Principal secrets use the `agcp_` prefix. Only hash + display prefix are persisted.

A disabled or expired Principal cannot authenticate even if its Role Bindings still exist.

## Roles

Built-in roles remain intentionally small:

- `owner` — all Control Plane permissions, including RBAC management.
- `admin` — operational/admin permissions, excluding RBAC management.
- `operator` — operational resource management, no privilege escalation.
- `viewer` — read-oriented access.

A role is a permission bundle. HTTP/domain authorization tests explicit permissions rather than hard-coding ad-hoc role checks.

The authoritative permission vocabulary and role mapping live in `@agent-gateway/control-plane-auth`. Billing uses the same `hasPermission` / `requirePermission` evaluator through the package's billing submodule; it does not maintain a second handler-local role policy.

## Scopes

Role Bindings support:

- `global` — applies to gateway-global resources and every Tenant.
- `tenant` — applies only to operations explicitly scoped to that Tenant.

Provider, Credential, Channel and RBAC resources are global.

Project/Virtual Key and Billing Tenant resources may be authorized by a matching Tenant binding.

RBAC management remains global-only.

## Billing-domain permissions

v0.6 adds these permissions to the central Control Plane permission vocabulary:

```text
billing.accounts.read
billing.accounts.write
billing.pricing.read
billing.pricing.write
billing.credits.write
billing.usage.read
billing.ledger.read
billing.reservations.read
```

Billing role bundles:

- `owner` — billing read + write.
- `admin` — billing read + write.
- `operator` — billing read only.
- `viewer` — billing read only.

Tenant-scoped billing authorization applies only to the matching Tenant.

Raw global PriceRule rows, global PriceRule mutation and unfiltered/cross-Tenant financial reads require a global binding. A Tenant-scoped pricing read sees only that Tenant's owned rules rather than gateway-global rule rows.

## Control Plane authentication

```http
Authorization: Bearer agcp_...
```

The bootstrap token is checked first and represented internally as a synthetic global owner. It is not a persisted Principal.

## Mutation transaction boundary

A successful governed mutation is one atomic durable unit:

```text
resource mutation
+ success AuditEvent
+ completed idempotency replay record
= one Postgres transaction
```

This applies equally to operational mutations and Billing Control Plane mutations.

Repositories participating in the same governed mutation are attached to the Control Plane transaction context. For Billing v0.6 this includes `PostgresBillingStore.pool`.

If any step fails before commit, all durable effects roll back. The gateway then appends a separate `outcome=error` AuditEvent after rollback.

Runtime-only derived work occurs after durable commit and must not turn an already-committed mutation into a false retry signal.

## Control Plane idempotency

Management mutations use:

```http
Idempotency-Key: caller-generated-key
```

Durable scope:

```text
actor + operation + Idempotency-Key
```

The complete semantic request participates in the fingerprint. Only the hash is persisted.

Outcomes:

- first request: pending claim + execute;
- same key / different request: conflict;
- same key while pending: in-progress conflict;
- completed request: replay original response;
- expired record: reclaimable.

Completed replay responses are encrypted with the Credential keyring because Control Plane responses may contain one-time secrets and because the same replay mechanism is reused by financial mutations.

A completed replay is itself audited with the current `X-Request-Id`, but the underlying resource/financial mutation is not repeated.

Expired idempotency rows are purged opportunistically in bounded batches and exact-key expiry cleanup prevents a backlog from blocking reuse.

## Billing idempotency

Every Billing Control Plane mutation requires `Idempotency-Key`; it is not optional for financial writes.

Missing, empty or oversized Billing mutation idempotency headers are authenticated mutation failures and produce `outcome=error` AuditEvents.

The management idempotency layer protects the complete API mutation. Financial primitives may add a second domain key where needed.

For `credit.grant`, the immutable Ledger idempotency identity is scoped by:

```text
ControlPrincipal + billing.credit.grant + Tenant + management key + semantic request fingerprint
```

The extra semantic fingerprint matters because the management idempotency row may expire and allow the same raw key to be reclaimed. A changed amount/reason after expiry must never resolve to an older Ledger credit while being audited as a new success.

## Audit trail

AuditEvent is durable governance evidence, not an ordinary log.

Audited actions include:

- successful Control Plane mutations;
- authenticated authorization denials;
- mutation validation/idempotency errors after authentication;
- mutation errors after rollback;
- completed idempotent replays;
- sensitive reads such as Credentials, RBAC, Audit, BillingAccount, PriceRule, Usage, Ledger and Reservation queries.

Each event records:

- actor type / id / name
- request id
- action
- resource type and optional resource id
- optional Tenant scope
- outcome (`success`, `denied`, `error`)
- non-secret metadata
- immutable creation timestamp

Never place bearer tokens, Virtual Key secrets, Credential payloads/ciphertext/master keys or other secret material in Audit metadata.

## Append-only guarantee

`gateway_audit_events` is database-enforced append-only. `UPDATE` and `DELETE` are rejected by triggers.

Financial history has its own independent immutability guarantees: UsageEvent and LedgerEntry cannot be mutated merely because the caller has Control Plane write permission.

A Billing administrator can append governed financial events such as `credit.grant`; it cannot edit an existing Ledger entry.

## Request IDs

Every Control Plane response includes `X-Request-Id`.

Caller-supplied values are retained up to 256 characters; otherwise the gateway creates one. Audit evidence uses the same id.

## Audit API

```http
GET /api/gateway/admin/audit
```

Filters:

- `limit`
- `actor_id`
- `resource_type`
- `resource_id`
- `tenant_id`
- `outcome`

Tenant-scoped callers must query the matching Tenant. Global callers may query globally according to their permission.

## Security invariants

- Principal plaintext tokens are never stored.
- authorization happens before governed mutation.
- Tenant scope cannot authorize another Tenant.
- global-only operations require global authorization.
- Billing permissions are evaluated by the same central RBAC core as non-Billing permissions.
- Billing monetary/policy writes require owner/admin billing permissions.
- operator/viewer cannot grant credits or change BillingAccount/Pricing state.
- resource mutation, success AuditEvent and idempotency completion commit atomically.
- failed durable transaction leaves no success AuditEvent/completed replay behind.
- authenticated denials, Billing idempotency-header rejections and completed replays create audit evidence.
- Billing reads are auditable.
- AuditEvent is append-only.
- UsageEvent and LedgerEntry remain immutable regardless of Control Plane role.
- Audit metadata is secret-free.
- bootstrap access is external break-glass identity, not a recoverable database credential.
