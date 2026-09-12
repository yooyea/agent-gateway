# API Specification

## 1. Compatibility strategy

The Data Plane should look like an Agents API, not like a proprietary gateway protocol.

The first compatibility target is the OpenAI Agents API Session surface. Gateway-specific selection and policy are expressed through headers so standard request bodies remain portable.

The Control Plane uses gateway-native resources under `/api/gateway/*`.

## 2. Authentication

### Data Plane

```http
Authorization: Bearer ag_xxx
```

A Virtual Key resolves to Tenant and optional Project context. In the durable path plaintext is never stored; authentication hashes the presented secret and looks up the hash.

### Control Plane

Normal Control Plane access uses persisted Principal tokens:

```http
Authorization: Bearer agcp_xxx
```

The Principal resolves to Role Bindings and permissions.

The environment value `AGENT_GATEWAY_ADMIN_TOKEN` remains supported only as bootstrap / break-glass access. It is represented internally as a synthetic global owner and is not stored in Postgres.

Control Plane responses include:

```http
X-Request-Id: req_...
```

A caller-supplied `X-Request-Id` is preserved up to 256 characters; otherwise the gateway creates one. Audit events persist the same request id.

## 3. Data Plane

### Create Session

```http
POST /agents/sessions
Idempotency-Key: caller-generated-key
```

Body follows the upstream Agents API shape:

```json
{
  "agent": {
    "instructions": "Inspect the repository and implement the task."
  },
  "environment": { "type": "none" },
  "input": "Start the task.",
  "metadata": { "source": "ci" },
  "stream": false
}
```

The gateway allocates and persists the `agsess_*` route before making the upstream create call. On success the binding becomes `bound`; on provider error it becomes `failed`.

Response preserves provider-native fields but replaces the routing identity:

```json
{
  "id": "agsess_...",
  "object": "agent.session",
  "status": "idle",
  "usage": {},
  "gateway": {
    "provider": "openai-agents",
    "channel": "openai-primary"
  }
}
```

A completed idempotent replay returns the stored response and header:

```http
X-Agent-Gateway-Idempotent-Replay: true
```

### Retrieve Session

```http
GET /agents/sessions/{gateway_session_id}
```

The gateway resolves the durable SessionBinding and retrieves state from the pinned Channel.

### Submit Session events

```http
POST /agents/sessions/{gateway_session_id}/events
```

```json
{
  "events": [{
    "type": "agent.session.input.message",
    "input": [{
      "role": "user",
      "content": [{ "type": "input_text", "text": "Continue." }]
    }]
  }],
  "idempotency_key": "client-generated-key"
}
```

### Stream Session events

```http
GET /agents/sessions/{gateway_session_id}/events
Accept: text/event-stream
```

The gateway streams events from the original bound Channel.

## 4. Gateway routing headers

```http
X-Agent-Gateway-Provider: openai-agents
X-Agent-Gateway-Channel: openai-primary
X-Agent-Gateway-Required-Capabilities: sandbox,mcp,streaming
X-Agent-Gateway-Max-Cost-Usd: 2.00
```

Channel takes precedence over Provider. Required capabilities fail closed. Max cost is currently persisted as SessionBudget metadata; hard enforcement belongs to the reservation/metering layer.

Routing hints participate in the Session-create idempotency fingerprint.

## 5. Control Plane permissions

The current built-in permission vocabulary is:

```text
tenants.write
projects.write
keys.write
providers.read
providers.write
credentials.read
credentials.write
credentials.rewrap
channels.read
channels.write
rbac.read
rbac.manage
audit.read
```

Built-in roles are permission bundles:

- `owner` — all permissions.
- `admin` — all operational permissions and audit access, excluding `rbac.manage`.
- `operator` — tenant/project/key plus Provider/Credential/Channel operations.
- `viewer` — read-only Provider/Credential/Channel/RBAC/audit metadata.

Role Bindings are scoped as either `global` or `tenant`.

Provider, Credential, Channel, RBAC and unfiltered Audit operations are global resources. Tenant-scoped bindings cannot authorize those operations.

## 6. Tenant / Project / Virtual Key Control Plane

```text
POST /api/gateway/admin/tenants
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

Required permissions:

- Tenant create: `tenants.write` global.
- Project create: `projects.write` global or matching tenant scope.
- Virtual Key create: `keys.write` global or matching tenant scope.

Virtual Key creation returns `key: "ag_..."` exactly once. Durable storage keeps only the key hash and display prefix.

## 7. Provider Control Plane

```text
GET   /api/gateway/admin/providers
POST  /api/gateway/admin/providers
PATCH /api/gateway/admin/providers/{provider_id}
```

Permissions:

- GET: `providers.read`
- POST/PATCH: `providers.write`

Create example:

```json
{
  "type": "openai-agents",
  "display_name": "OpenAI Agents API",
  "enabled": true,
  "config": {}
}
```

`type` must exist in the trusted server-side Provider plugin catalog. Database/API input cannot supply an arbitrary module path.

Provider config is non-secret. Secret-like fields are rejected.

## 8. Credential Control Plane

```text
GET   /api/gateway/admin/credentials
POST  /api/gateway/admin/credentials
PATCH /api/gateway/admin/credentials/{credential_id}
POST  /api/gateway/admin/credentials/{credential_id}/rewrap
```

Permissions:

- GET: `credentials.read`
- POST/PATCH: `credentials.write`
- rewrap: `credentials.rewrap`

Create example:

```json
{
  "provider_id": "agprov_...",
  "name": "production-openai",
  "kind": "api_key",
  "payload": {
    "apiKey": "sk-..."
  }
}
```

The request payload is encrypted before durable storage. Control Plane responses return Credential metadata only and never return plaintext or ciphertext.

`PATCH` replaces the upstream secret payload and encrypts it with the currently active master key.

`POST .../rewrap` keeps the provider secret unchanged but decrypts/re-encrypts the Credential with the current active master key.

Credential metadata reads and mutations are audited without copying Credential payload/ciphertext into the AuditEvent.

## 9. Channel Control Plane

```text
GET   /api/gateway/admin/channels
POST  /api/gateway/admin/channels
PATCH /api/gateway/admin/channels/{channel_id}
```

Permissions:

- GET: `channels.read`
- POST/PATCH: `channels.write`

Create example:

```json
{
  "provider_id": "agprov_...",
  "credential_id": "agcred_...",
  "name": "openai-primary",
  "enabled": true,
  "priority": 100,
  "weight": 100,
  "config": {
    "baseUrl": "https://api.openai.com/v1",
    "defaultModel": "gpt-6-astra"
  }
}
```

A Channel may reference only a Credential owned by the same Provider.

Provider/Channel mutations and Credential secret replacement rebuild the in-process runtime registry. Stable Channel IDs preserve existing SessionBinding resolution.

### Runtime Channel view

```http
GET /api/gateway/channels
Authorization: Bearer ag_xxx
```

The Data Plane-authenticated view reports runtime health/circuit information without exposing Credential material.

## 10. Control Principals and Role Bindings

### Principals

```text
GET   /api/gateway/admin/principals
POST  /api/gateway/admin/principals
PATCH /api/gateway/admin/principals/{principal_id}
```

Permissions:

- GET: `rbac.read`
- POST/PATCH: `rbac.manage`

Create example:

```json
{
  "name": "platform-ops",
  "expires_at": "2027-01-01T00:00:00Z"
}
```

Create response includes a one-time plaintext token:

```json
{
  "id": "agcp_...",
  "name": "platform-ops",
  "tokenPrefix": "agcp_...",
  "enabled": true,
  "token": "agcp_..."
}
```

The full token is never returned again.

`PATCH` currently supports enable/disable:

```json
{ "enabled": false }
```

### Role Bindings

```text
GET    /api/gateway/admin/role-bindings
POST   /api/gateway/admin/role-bindings
DELETE /api/gateway/admin/role-bindings/{binding_id}
```

Permissions:

- GET: `rbac.read`
- POST/DELETE: `rbac.manage`

Global binding example:

```json
{
  "principal_id": "agcp_...",
  "role": "admin",
  "scope_type": "global"
}
```

Tenant binding example:

```json
{
  "principal_id": "agcp_...",
  "role": "operator",
  "scope_type": "tenant",
  "scope_id": "tenant_..."
}
```

RBAC mutation is intentionally global-only. Tenant-scoped bindings cannot call the RBAC management endpoints.

## 11. Audit API

```http
GET /api/gateway/admin/audit
```

Permission: `audit.read`.

Supported query parameters:

```text
limit
actor_id
resource_type
resource_id
tenant_id
outcome=success|denied|error
```

A caller with only a tenant-scoped `audit.read` binding must supply the matching `tenant_id`. Global callers may query without a tenant filter.

Audit events are append-only and include the same `X-Request-Id` returned by the Control Plane response.

Successful mutations, mutation errors, authenticated authorization denials, and sensitive RBAC/Credential/audit reads generate audit evidence.

## 12. Credential encryption configuration

The runtime keyring is supplied outside the API:

```text
AGENT_GATEWAY_CREDENTIAL_KEYS
AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID
```

Each configured key must decode from base64 to exactly 32 bytes. Multiple keys may be retained for decryption during rotation; only the active key encrypts new/rewrapped records.

See `docs/credentials.md` for the rotation procedure.

## 13. Error model

Gateway errors use:

```json
{
  "error": {
    "type": "gateway_error",
    "message": "..."
  }
}
```

Expected HTTP classes:

- `400`: invalid route/policy/capability/input, unknown Provider type, plaintext secret config, invalid role/scope
- `401`: invalid/missing Virtual Key or Control Plane Principal/bootstrap token
- `403`: authenticated Control Plane Principal lacks the required permission/scope
- `404`: Session/Provider/Credential/Channel/Principal/RoleBinding not found
- `409`: idempotency, binding-state, duplicate, FK/ownership or state conflict
- `429`: rate/quota/concurrency/budget admission failure
- `502/503`: upstream Provider/Channel or required control-plane dependency unavailable

Provider-native errors may be retained in protected traces/audit data, but secret-bearing upstream details must not be leaked blindly to callers.

## 14. Idempotency semantics

Session creation uses `Idempotency-Key` scoped by:

```text
Tenant + VirtualKey + operation + Idempotency-Key
```

Outcomes:

- first request: claim pending and execute
- same key, different fingerprint: `409`
- same key, same fingerprint while pending: `409` in progress
- same key after completion: replay original response
- after TTL expiry: key may be claimed again

Session input/tool events continue to use the upstream-compatible body field `idempotency_key`.

## 15. Identifier prefixes

Current/new resource patterns include:

```text
tenant_     Tenant
project_    Project
vk_         Virtual Key record
ag_         Virtual Key secret
agprov_     Provider
agcred_     Credential
agch_       Channel
agsess_     Session
agcp_       Control Principal record / token prefix family
agrb_       Role Binding
agaud_      Audit Event
req_        generated request correlation id
```

Identifiers are opaque to clients.
