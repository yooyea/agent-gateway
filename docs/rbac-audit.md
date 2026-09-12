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

If the caller sends `X-Request-Id`, it is retained (up to 256 characters); otherwise the gateway creates one. The same id is persisted on the audit event so API failures can be correlated with the audit trail.

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
- Denied authenticated operations produce audit evidence.
- RBAC management requires a global `owner` permission path.
- Audit rows are append-only.
- Audit metadata is secret-free.
- The bootstrap credential is not a database Principal and cannot be recovered from Postgres.
