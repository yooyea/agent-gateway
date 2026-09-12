# API Specification

## 1. Compatibility strategy

The Data Plane should look like an Agents API, not like a proprietary gateway protocol.

The first compatibility target is the OpenAI Agents API session surface. Gateway-specific selection and policy are expressed through headers so standard request bodies remain portable.

The Control Plane uses gateway-native resources under `/api/gateway/*`.

## 2. Authentication

```http
Authorization: Bearer ag_xxx
```

A Virtual Key resolves to Tenant and optional Project context.

Production keys must be revocable, expirable and stored hashed at rest.

## 3. Data Plane

### Create session

```http
POST /agents/sessions
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

The gateway returns provider-native session fields but replaces the native ID with a gateway-owned ID:

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

The provider-native session ID is not part of the caller routing contract.

### Retrieve session

```http
GET /agents/sessions/{gateway_session_id}
```

The gateway resolves the SessionBinding and retrieves state from the pinned Channel.

### Submit session events

```http
POST /agents/sessions/{gateway_session_id}/events
```

Example:

```json
{
  "events": [
    {
      "type": "agent.session.input.message",
      "input": [
        {
          "role": "user",
          "content": [{ "type": "input_text", "text": "Continue." }]
        }
      ]
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

### Explicit provider

```http
X-Agent-Gateway-Provider: openai-agents
```

### Explicit channel

```http
X-Agent-Gateway-Channel: openai-primary
```

Channel takes precedence over Provider.

### Required capabilities

```http
X-Agent-Gateway-Required-Capabilities: sandbox,mcp,streaming
```

The request must fail rather than silently degrade if no eligible Channel can satisfy the requirement.

### Session cost ceiling

```http
X-Agent-Gateway-Max-Cost-Usd: 2.00
```

The current code records this as SessionBudget metadata. Production budget enforcement requires reservation + metering + hard-stop policy described in `billing.md`.

## 5. Control Plane

The target resource surface is:

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

`GET /api/gateway/channels` is implemented in v0.2 as the first bootstrap management endpoint.

## 6. Error model

Gateway errors use a stable envelope:

```json
{
  "error": {
    "type": "gateway_error",
    "message": "..."
  }
}
```

Expected HTTP classes:

- `400`: invalid route/policy/capability request
- `401`: invalid or missing Virtual Key
- `403`: tenant/project policy forbids the operation
- `404`: resource not visible in caller Tenant
- `409`: idempotency/state conflict
- `429`: rate/quota/concurrency/budget admission failure
- `502/503`: upstream provider/channel unavailable

Provider-native errors may be retained in trace/audit data, but secret-bearing upstream details must not be leaked blindly to callers.

## 7. Idempotency

All production mutations require an idempotency story.

Session events already carry `idempotency_key` in the upstream-compatible body. Session creation should support a gateway idempotency header in the durable implementation:

```http
Idempotency-Key: ...
```

The persisted idempotency record must include Tenant scope and request fingerprint.

## 8. Identifier prefixes

Recommended gateway-owned prefixes:

```text
agtn_      Tenant
agprj_     Project
agkey_     Virtual Key record (secret value remains ag_...)
agprov_    Provider configuration
agch_      Channel
agsess_    Session
agexec_    Execution
agusg_     UsageEvent
agres_     Reservation
agled_     LedgerEntry
agpol_     Policy
```

Identifiers are opaque; clients must not parse business meaning from them beyond recognizing the resource class.
