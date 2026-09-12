# API Specification

## 1. Compatibility strategy

The Data Plane should look like an Agents API, not like a proprietary gateway protocol.

The first compatibility target is the OpenAI Agents API Session surface. Gateway-specific selection and policy are expressed through headers so standard request bodies remain portable.

The Control Plane uses gateway-native resources under `/api/gateway/*`.

## 2. Authentication

Data Plane:

```http
Authorization: Bearer ag_xxx
```

A Virtual Key resolves to Tenant and optional Project context. In the durable path plaintext is never stored; authentication hashes the presented secret and looks up the hash.

Bootstrap Control Plane:

```http
Authorization: Bearer <AGENT_GATEWAY_ADMIN_TOKEN>
```

The bootstrap admin token is an implementation bridge, not the final RBAC design.

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

## 5. Bootstrap Control Plane

### Tenant / Project / Virtual Key

```text
POST /api/gateway/admin/tenants
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

Virtual Key creation returns `key: "ag_..."` exactly once. Durable storage keeps only the key hash and display prefix.

### Providers

```text
GET   /api/gateway/admin/providers
POST  /api/gateway/admin/providers
PATCH /api/gateway/admin/providers/{provider_id}
```

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

### Credentials

```text
GET   /api/gateway/admin/credentials
POST  /api/gateway/admin/credentials
PATCH /api/gateway/admin/credentials/{credential_id}
POST  /api/gateway/admin/credentials/{credential_id}/rewrap
```

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

### Channels

```text
GET   /api/gateway/admin/channels
POST  /api/gateway/admin/channels
PATCH /api/gateway/admin/channels/{channel_id}
```

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

The data-plane-authenticated view reports runtime health/circuit information without exposing Credential material.

## 6. Credential encryption configuration

The runtime keyring is supplied outside the API:

```text
AGENT_GATEWAY_CREDENTIAL_KEYS
AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID
```

Each configured key must decode from base64 to exactly 32 bytes. Multiple keys may be retained for decryption during rotation; only the active key encrypts new/rewrapped records.

See `docs/credentials.md` for the rotation procedure.

## 7. Target Control Plane

The long-term RBAC-aware resource surface remains broader:

```text
GET/POST/PATCH /api/gateway/tenants
GET/POST/PATCH /api/gateway/projects
GET/POST/PATCH /api/gateway/keys
GET/POST/PATCH /api/gateway/providers
GET/POST/PATCH /api/gateway/credentials
GET/POST/PATCH /api/gateway/channels
GET/POST/PATCH /api/gateway/policies
GET            /api/gateway/sessions
GET            /api/gateway/usage
GET/POST/PATCH /api/gateway/pricing
GET            /api/gateway/ledger
GET            /api/gateway/audit
```

The current `/admin/*` bootstrap routes will be replaced or wrapped by RBAC-aware APIs rather than becoming the permanent public contract.

## 8. Error model

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

- `400`: invalid route/policy/capability/input, unknown Provider type, or plaintext secret config
- `401`: invalid/missing Virtual Key or bootstrap admin token
- `403`: policy forbids operation
- `404`: Session/Provider/Credential/Channel not found
- `409`: idempotency, binding-state, duplicate, FK/ownership or state conflict
- `429`: rate/quota/concurrency/budget admission failure
- `502/503`: upstream Provider/Channel or required control-plane dependency unavailable

Provider-native errors may be retained in protected traces/audit data, but secret-bearing upstream details must not be leaked blindly to callers.

## 9. Idempotency semantics

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

## 10. Identifier prefixes

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
```

Identifiers are opaque to clients.
