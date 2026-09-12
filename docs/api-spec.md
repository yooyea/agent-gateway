# API Specification

## 1. Compatibility strategy

The Data Plane should look like an Agents API, not like a proprietary gateway protocol.

The first compatibility target is the OpenAI Agents API session surface. Gateway-specific selection and policy are expressed through headers so standard request bodies remain portable.

The Control Plane uses gateway-native resources under `/api/gateway/*`.

## 2. Authentication

Data Plane:

```http
Authorization: Bearer ag_xxx
```

A Virtual Key resolves to Tenant and optional Project context. In the durable path the plaintext key is never stored; authentication hashes the presented secret and looks up the hash.

Bootstrap Control Plane:

```http
Authorization: Bearer <AGENT_GATEWAY_ADMIN_TOKEN>
```

The bootstrap admin token is an implementation bridge, not the final RBAC design.

## 3. Data Plane

### Create session

```http
POST /agents/sessions
Idempotency-Key: caller-generated-key
```

Body follows the upstream Agents API shape:

```json
{
  "agent": {
    "model": "gpt-6-astra",
    "instructions": "Inspect the repository and implement the task."
  },
  "environment": { "type": "none" },
  "input": "Start the task.",
  "metadata": { "source": "ci" },
  "stream": false
}
```

The gateway allocates and persists the `agsess_*` route before making the upstream create call. On success the binding becomes `bound`; on a provider error it becomes `failed`.

Response preserves provider-native session fields but replaces the routing identity:

```json
{
  "id": "agsess_...",
  "object": "agent.session",
  "status": "idle",
  "agent": {},
  "environment": {},
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

The provider-native session ID is not part of the caller routing contract.

### Retrieve session

```http
GET /agents/sessions/{gateway_session_id}
```

The gateway resolves the durable SessionBinding and retrieves state from the pinned Channel.

### Submit session events

```http
POST /agents/sessions/{gateway_session_id}/events
```

```json
{
  "events": [
    {
      "type": "agent.session.input.message",
      "input": [{
        "role": "user",
        "content": [{ "type": "input_text", "text": "Continue." }]
      }]
    }
  ],
  "idempotency_key": "client-generated-key"
}
```

### Stream session events

```http
GET /agents/sessions/{gateway_session_id}/events
Accept: text/event-stream
```

The gateway resolves the binding and streams events from the original Channel.

## 4. Gateway routing headers

```http
X-Agent-Gateway-Provider: openai-agents
X-Agent-Gateway-Channel: openai-primary
X-Agent-Gateway-Required-Capabilities: sandbox,mcp,streaming
X-Agent-Gateway-Max-Cost-Usd: 2.00
```

Channel takes precedence over Provider. Required capabilities fail closed. The max-cost value is currently persisted as SessionBudget metadata; hard enforcement is implemented with the later reservation/metering layer.

Routing hints participate in the session-create idempotency fingerprint. Reusing an idempotency key with a different channel/provider/budget is therefore a conflict.

## 5. Bootstrap Control Plane implemented now

### Create Tenant

```http
POST /api/gateway/admin/tenants
```

```json
{ "name": "Acme" }
```

### Create Project

```http
POST /api/gateway/admin/projects
```

```json
{ "tenant_id": "tenant_...", "name": "Production" }
```

### Create Virtual Key

```http
POST /api/gateway/admin/virtual-keys
```

```json
{
  "tenant_id": "tenant_...",
  "project_id": "project_...",
  "name": "production-ci",
  "expires_at": "2027-01-01T00:00:00Z"
}
```

The response includes `key: "ag_..."` exactly once. Durable storage keeps only `key_hash` and `key_prefix`.

### List runtime Channels

```http
GET /api/gateway/channels
Authorization: Bearer ag_xxx
```

## 6. Target Control Plane

The eventual resource surface remains broader:

```text
GET/POST/PATCH /api/gateway/tenants
GET/POST/PATCH /api/gateway/projects
GET/POST/PATCH /api/gateway/keys
GET/POST/PATCH /api/gateway/providers
GET/POST/PATCH /api/gateway/channels
GET/POST/PATCH /api/gateway/policies
GET            /api/gateway/sessions
GET            /api/gateway/usage
GET/POST/PATCH /api/gateway/pricing
GET            /api/gateway/ledger
GET            /api/gateway/audit
```

The `/admin/*` bootstrap routes will be replaced or wrapped by RBAC-aware resource APIs rather than becoming the permanent public contract.

## 7. Error model

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

- `400`: invalid route/policy/capability/input request
- `401`: invalid or missing Virtual Key / bootstrap admin token
- `403`: tenant/project policy forbids the operation
- `404`: resource not visible in caller Tenant
- `409`: idempotency, binding-state, duplicate or ownership conflict
- `429`: rate/quota/concurrency/budget admission failure
- `502/503`: upstream provider/channel or control-plane dependency unavailable

Provider-native errors may be retained in trace/audit data, but secret-bearing upstream details must not be leaked blindly to callers.

## 8. Idempotency semantics

Session creation uses the HTTP `Idempotency-Key` header.

Persisted scope:

```text
Tenant + VirtualKey + operation + Idempotency-Key
```

The record stores a canonical request fingerprint. Outcomes:

- first request: claim pending and execute
- same key, different fingerprint: `409`
- same key, same fingerprint while pending: `409` in progress
- same key after completion: replay original response
- after TTL expiry: key may be claimed again

Pending defaults to 900 seconds; completed response replay defaults to 86400 seconds and both are configurable.

Session input/tool events continue to use the upstream-compatible body field `idempotency_key`.

## 9. Identifier prefixes

Current code uses:

```text
tenant_    Tenant
project_   Project
vk_        Virtual Key record
ag_        Virtual Key secret
agsess_    Session
```

Future resource prefixes may become more compact or globally standardized, but identifiers remain opaque to clients.
