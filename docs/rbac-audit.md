# Control Plane RBAC and Audit

## Purpose

The Control Plane must not depend on one shared administrator bearer token for normal operation.

`AGENT_GATEWAY_ADMIN_TOKEN` remains a bootstrap / break-glass credential only. Normal operators use persisted Control Plane Principals whose token secrets are returned once, hashed with SHA-256 at rest, and authorized through Role Bindings.

## Principal model

```text
Principal
  -> RoleBinding
      -> Role
      -> Scope
      -> Permissions
```

Principal secrets use the `agcp_` prefix. Only the hash and display prefix are persisted.

A disabled or expired Principal cannot authenticate even if its Role Bindings still exist.

## Roles

Built-in roles are intentionally small and stable:

- `owner` — all Control Plane permissions, including RBAC management.
- `admin` — all operational permissions plus audit access, but cannot change RBAC.
- `operator` — tenant/project/key lifecycle plus Provider/Credential/Channel operations.
- `viewer` — read-only access to Provider/Credential/Channel metadata, RBAC metadata and audit events.

The permission layer remains explicit so custom roles can be introduced later without changing HTTP authorization semantics.

## Scopes

Role Bindings support:

- `global` — applies to gateway-global resources and every tenant.
- `tenant` — applies only when an operation is explicitly scoped to the bound Tenant.

Provider, Credential, Channel and RBAC resources are global resources. Tenant-scoped bindings therefore cannot mutate those resources.

Project and Virtual Key creation carry a Tenant scope and can be authorized by a matching tenant-scoped binding.

RBAC management itself is deliberately global-only. A tenant-scoped owner cannot create a global Role Binding or elevate itself.

## Control Plane authentication

Control Plane requests use:

```http
Authorization: Bearer agcp_...
```

The bootstrap token configured by `AGENT_GATEWAY_ADMIN_TOKEN` is checked first and is represented internally as a synthetic global owner. It should be stored outside the database, rotated separately and kept unavailable to routine operators.

## Bootstrap flow

1. Start the gateway with `AGENT_GATEWAY_ADMIN_TOKEN`.
2. Create a Principal:

```http
POST /api/gateway/admin/principals
```

```json
{
  "name": "platform-ops"
}
```

The response contains the plaintext `agcp_...` token exactly once.

3. Create a Role Binding:

```http
POST /api/gateway/admin/role-bindings
```

```json
{
  "principal_id": "agcp_...",
  "role": "admin",
  "scope_type": "global"
}
```

4. Store the Principal token in the operator's secret manager.
5. Use that token for normal Control Plane work.

## Mutation transaction boundary

A successful Control Plane mutation is one atomic durable unit:

```text
resource mutation
+ success AuditEvent
+ completed idempotency replay record (when Idempotency-Key is present)
= one Postgres transaction
```

The resource repository and the Control Plane security repository share the same transaction client while this unit runs.

If any step fails before commit, all three durable effects roll back together. The gateway then appends a separate `outcome=error` AuditEvent after rollback. This prevents the API from reporting a failed one-time-secret operation after the resource was actually committed.

Runtime-only work such as rebuilding the in-process Channel registry occurs **after** the durable transaction commits. A runtime reload failure is audited separately and must not convert an already committed durable mutation into a retryable API failure.

## Control Plane idempotency

Every Control Plane mutation accepts:

```http
Idempotency-Key: caller-generated-key
```

The durable scope is:

```text
actor + operation + Idempotency-Key
```

The full semantic request participates in the request fingerprint, including secret-bearing Credential payload values. Only the hash is persisted; request plaintext is not written to idempotency or audit storage.

Outcomes:

- first request claims a pending record and executes;
- same key + different fingerprint returns conflict;
- same key + same fingerprint while pending returns in-progress conflict;
- completed request replays the original status/body and returns `X-Agent-Gateway-Idempotent-Replay: true`;
- expired rows may be reclaimed.

Completed replay bodies can include one-time Principal or Virtual Key secrets, so the replay body is encrypted with the Credential keyring before durable storage.

Idempotency claim/decryption errors occur inside the audited mutation error boundary. Authenticated conflict, in-progress and replay-decryption failures therefore leave error audit evidence.

A completed replay is also a security-relevant successful Control Plane request. The replay path records audit evidence using the **current** `X-Request-Id`, while the underlying resource mutation is not executed again.

Expired idempotency rows are cleaned opportunistically in bounded batches on mutation traffic, with exact-key expiry cleanup guaranteeing that a large backlog cannot block reuse of the current expired key. The persistence layer also exposes a bounded explicit purge operation for maintenance.

## Audit trail

Every successful Control Plane mutation is appended to `gateway_audit_events`.

Authorization denials are also appended when the caller has authenticated but lacks the required permission.

Sensitive reads such as Credential metadata, RBAC metadata and audit access are logged as successful audit events.

Each event records:

- actor type / id / name
- request id
- action
- resource type and optional resource id
- optional tenant scope
- outcome: `success`, `denied`, or `error`
- non-secret metadata
- immutable creation timestamp

Bearer tokens, Virtual Key secrets, Credential payloads and decrypted upstream credentials must never enter audit metadata.

## Append-only guarantee

`gateway_audit_events` is protected by Postgres triggers that reject `UPDATE` and `DELETE`.

The application only has an append API. No repository method exists for modifying or deleting audit rows.

This protects the audit history from accidental application-level mutation. Production deployments should additionally use database roles so the gateway runtime cannot alter the trigger/function definitions.

## Request IDs

Control Plane responses include `X-Request-Id`.

If the caller sends `X-Request-Id`, it is retained (up to 256 characters); otherwise the gateway creates one. The same id is persisted on the audit event so API failures and idempotent replays can be correlated with the audit trail.

## Audit API

```http
GET /api/gateway/admin/audit
```

Supported filters:

- `limit`
- `actor_id`
- `resource_type`
- `resource_id`
- `tenant_id`
- `outcome`

Tenant-scoped callers must specify their tenant id and can only access events for that tenant. Global viewers/admins can query globally.

## Security invariants

- Principal tokens are never stored in plaintext.
- RBAC decisions happen before a mutation reaches the durable resource store.
- Resource mutation, success audit, and idempotency completion commit atomically.
- Failed durable transactions do not leave a success AuditEvent or completed replay record behind.
- Authenticated idempotency rejections and completed replays produce audit evidence.
- Denied authenticated operations produce audit evidence.
- RBAC management requires a global `owner` permission path.
- Audit rows are append-only.
- Audit metadata is secret-free.
- The bootstrap credential is not a database Principal and cannot be recovered from Postgres.
