# API Specification

## 1. Compatibility strategy

The Data Plane should look like an Agents API, not like a proprietary gateway protocol.

The first compatibility target is the OpenAI Agents API Session surface. Gateway-specific routing, admission and budget policy use HTTP headers so provider-compatible request bodies remain portable.

The Control Plane uses gateway-native resources under `/api/gateway/*`.

## 2. Authentication and scope

### Data Plane

```http
Authorization: Bearer ag_xxx
```

A Virtual Key resolves to exactly one Tenant and optionally one Project. Durable storage keeps only the key hash and display prefix.

Scope rules:

- Tenant-level key: may access Sessions in that Tenant across Projects.
- Project-scoped key: may access only Sessions whose durable `project_id` matches the key Project.
- Cross-Tenant Session access is always hidden as not found.

Billing attribution is taken from the durable Session Tenant/Project, not from caller-supplied identity fields.

### Control Plane

Normal Control Plane access uses persisted Principal tokens:

```http
Authorization: Bearer agcp_xxx
```

The environment value `AGENT_GATEWAY_ADMIN_TOKEN` remains bootstrap / break-glass access only.

Control Plane responses, including errors, include:

```http
X-Request-Id: req_...
```

The same request id is persisted on relevant AuditEvents.

## 3. Create Session

```http
POST /agents/sessions
Authorization: Bearer ag_...
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

### Gateway routing/admission headers

```http
X-Agent-Gateway-Provider: openai-agents
X-Agent-Gateway-Channel: openai-primary
X-Agent-Gateway-Required-Capabilities: sandbox,mcp,streaming
X-Agent-Gateway-Max-Cost-USD: 2.00
```

`Channel` takes precedence over `Provider`. Required capabilities fail closed.

`X-Agent-Gateway-Max-Cost-USD`:

- must be greater than zero,
- accepts at most six decimal places,
- is converted directly from decimal text to integer USD micros without JavaScript floating-point arithmetic,
- is persisted internally as exact `SessionBudget.max_cost_micros`,
- participates in the create-session idempotency fingerprint in that exact representation.

Current billing activation rule:

- Tenant without BillingAccount: header is optional and execution remains unbilled/legacy.
- Tenant with enabled BillingAccount: header is required until plan/default budgets are introduced.
- Tenant with disabled BillingAccount: billed work is rejected.

### Creation order

The gateway performs:

```text
select Channel
  -> allocate agsess_...
  -> persist SessionBinding(state=creating)
  -> if billed: reserve exact max-cost capacity and attach Reservation
  -> call upstream Provider Session create
  -> persist bound | failed
```

If billing admission fails, the upstream Provider is not called and any reservation created during that pre-provider admission path may be released safely.

Once Provider invocation begins, the gateway treats a generic provider/binding failure as potentially side-effecting. It does not release the financial hold merely because the local binding later reports failure; the Reservation remains until explicit reconciliation or expiry/renewal handling. This prevents an upstream Session that may already exist from becoming unreserved.

Response preserves provider-native fields but rewrites public routing identity:

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

A completed idempotent replay adds:

```http
X-Agent-Gateway-Idempotent-Replay: true
```

## 4. Retrieve Session

```http
GET /agents/sessions/{gateway_session_id}
Authorization: Bearer ag_...
```

The gateway resolves the durable SessionBinding and retrieves provider state from the pinned Channel.

Status retrieval does not require remaining budget because it is used to establish current state. When provider `usage` is present, the gateway attempts best-effort usage observation/settlement.

Project/Tenant scope rules from section 2 apply.

## 5. Submit Session events

```http
POST /agents/sessions/{gateway_session_id}/events
Authorization: Bearer ag_...
```

Example body:

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

For a billed Session, before forwarding additional Agent work the gateway performs a strict financial preflight while holding an exclusive per-Session runtime lease:

```text
acquire per-Session lease
  -> retrieve provider Session
  -> observe cumulative usage
  -> settle usage delta
  -> fail closed if customer pricing is unresolved
  -> renew/reacquire expired Reservation capacity when necessary
  -> assert remaining SessionBudget
  -> only then POST events upstream
```

The per-Session lease serializes budget admission and provider work so overlapping requests cannot both pass the same remaining budget snapshot.

After successful upstream submission, usage reconciliation is best-effort. A post-success accounting refresh failure is not returned as a false mutation failure; the next expensive operation repeats strict preflight and catches up from cumulative usage.

The current body `idempotency_key` remains provider-compatible. Gateway-level Session-create idempotency uses the HTTP `Idempotency-Key` header.

## 6. Stream Session events

```http
GET /agents/sessions/{gateway_session_id}/events
Authorization: Bearer ag_...
Accept: text/event-stream
```

The gateway performs the same exclusive per-Session lease plus strict usage-refresh/budget preflight before opening the stream and streams from the original bound Channel.

After stream completion it best-effort retrieves the provider Session and reconciles cumulative usage.

Current limitation: Provider streaming is opaque bytes at the gateway Provider interface, so v0.5 cannot promise precise mid-stream budget cutoff. Hard admission happens immediately before stream start; cumulative usage is reconciled at completion. Future incremental usage callbacks/events are required for continuous in-flight enforcement.

## 7. Billing admission errors

### Insufficient Tenant billing capacity

```http
HTTP/1.1 402 Payment Required
X-Agent-Gateway-Limit-Type: billing_capacity
X-Agent-Gateway-Available-Micros: ...
X-Agent-Gateway-Requested-Micros: ...
```

### Hard budget required for billed Tenant

```http
HTTP/1.1 402 Payment Required
X-Agent-Gateway-Limit-Type: budget_required
```

### BillingAccount disabled

```http
HTTP/1.1 402 Payment Required
X-Agent-Gateway-Limit-Type: billing_disabled
```

### Customer price unavailable for observed billed usage

```http
HTTP/1.1 503 Service Unavailable
X-Agent-Gateway-Limit-Type: billing_price_unavailable
X-Agent-Gateway-Usage-Event-Id: agusg_...
```

The gateway fails closed instead of admitting more work against a budget whose customer charge cannot yet be determined.

### Session budget exhausted

```http
HTTP/1.1 429 Too Many Requests
X-Agent-Gateway-Limit-Type: budget
X-Agent-Gateway-Budget-Remaining-Micros: 0
```

Budget/capacity rejection occurs before new provider work.

Reservation expiry is an operational lease boundary, not an implicit Session lifetime. If a live Session still has unused budget, the gateway renews/reacquires the remaining Reservation amount under the BillingAccount lock. If that capacity was consumed elsewhere while the hold was expired, renewal fails with normal billing-capacity rejection.

## 8. Runtime Channel view

```http
GET /api/gateway/channels
Authorization: Bearer ag_xxx
```

The Data Plane-authenticated view reports runtime health/circuit information without exposing Credential material.

## 9. Control Plane permissions

Current built-in permission vocabulary:

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

Built-in roles:

- `owner` — all permissions.
- `admin` — operational permissions and audit access, excluding `rbac.manage`.
- `operator` — tenant/project/key plus Provider/Credential/Channel operations.
- `viewer` — read-only Provider/Credential/Channel/RBAC/audit metadata.

Role Bindings are `global` or `tenant` scoped. Provider, Credential, Channel and RBAC resources are global resources.

Billing management permissions/APIs are not yet exposed in the current Control Plane; the next layer will add explicit billing/pricing/usage/ledger permissions rather than reusing unrelated broad roles implicitly.

## 10. Tenant / Project / Virtual Key Control Plane

```text
POST /api/gateway/admin/tenants
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

Permissions:

- Tenant create: `tenants.write` global.
- Project create: `projects.write` global or matching tenant scope.
- Virtual Key create: `keys.write` global or matching tenant scope.

Virtual Key creation returns plaintext `key: "ag_..."` exactly once. Durable storage keeps only its hash and display prefix.

## 11. Provider Control Plane

```text
GET   /api/gateway/admin/providers
POST  /api/gateway/admin/providers
PATCH /api/gateway/admin/providers/{provider_id}
```

Permissions: GET `providers.read`; POST/PATCH `providers.write`.

`type` must exist in the trusted server-side Provider plugin catalog. Provider config is non-secret; secret-like fields are rejected.

## 12. Credential Control Plane

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

Credential payloads are encrypted before durable storage. Responses expose metadata only, never plaintext or ciphertext.

## 13. Channel Control Plane

```text
GET   /api/gateway/admin/channels
POST  /api/gateway/admin/channels
PATCH /api/gateway/admin/channels/{channel_id}
```

Permissions: GET `channels.read`; POST/PATCH `channels.write`.

A Channel may reference only a Credential owned by the same Provider. Runtime registry rebuild happens after durable Control Plane commit, while stable Channel IDs preserve existing Session affinity.

## 14. Control Principals and Role Bindings

Principals:

```text
GET   /api/gateway/admin/principals
POST  /api/gateway/admin/principals
PATCH /api/gateway/admin/principals/{principal_id}
```

Role Bindings:

```text
GET    /api/gateway/admin/role-bindings
POST   /api/gateway/admin/role-bindings
DELETE /api/gateway/admin/role-bindings/{binding_id}
```

Principal creation returns the full `agcp_...` token exactly once. The full token may only reappear through a completed idempotent replay whose stored envelope is encrypted at rest.

RBAC mutation is global-only.

## 15. Audit API

```http
GET /api/gateway/admin/audit
```

Permission: `audit.read`.

Filters include `limit`, `actor_id`, `resource_type`, `resource_id`, `tenant_id`, and `outcome=success|denied|error`.

Audit events are append-only and correlate with Control Plane `X-Request-Id` values.

## 16. Error model

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

- `400`: invalid input/routing/capability/budget-header syntax, unknown Provider type, plaintext secret config, invalid role/scope
- `401`: invalid/missing Virtual Key or Control Plane Principal/bootstrap token
- `402`: billed Tenant cannot financially admit new work (capacity, required budget, disabled billing)
- `403`: authenticated Control Plane Principal lacks permission/scope
- `404`: scoped resource not found, including cross-Tenant/cross-Project Session access
- `409`: idempotency, binding-state, duplicate, FK/ownership or state conflict
- `429`: rate/concurrency/session-budget admission failure
- `502/503`: upstream Provider/Channel, unresolved required pricing, or required infrastructure unavailable

Provider-native errors may be retained in protected traces/audit data, but secret-bearing upstream details must not be leaked blindly.

## 17. Idempotency semantics

### Data Plane Session creation

HTTP `Idempotency-Key` is scoped by:

```text
Tenant + VirtualKey + operation + Idempotency-Key
```

The fingerprint includes body, routing hints, capability hints and the exact normalized Session budget micros.

Outcomes:

- first request: pending claim and execute
- same key + different fingerprint: `409`
- same key + same fingerprint while pending: `409`
- completed key: replay original response
- expired key: may be claimed again

A pending claim is released only for failures known to happen before Provider invocation, such as billing-capacity/budget-required admission rejection or a gateway concurrency rejection. Once Provider invocation may have begun, an error is treated as potentially side-effecting and the claim remains pending until TTL/reconciliation; immediate retry is intentionally blocked to avoid duplicate Agent Sessions and duplicate spend.

If upstream work succeeded but durable idempotency completion fails, the claim is deliberately not released for the same reason.

### Control Plane mutations

Management mutations accept the same HTTP header but are scoped by ControlPrincipal/bootstrap actor + operation + key.

Control Plane replay state can contain one-time secrets and is therefore encrypted at rest. Resource mutation, success AuditEvent and idempotency completion commit atomically.

## 18. Identifier prefixes

```text
tenant_     Tenant
project_    Project
vk_         Virtual Key record
ag_         Virtual Key secret
agprov_     Provider
agcred_     Credential
agch_       Channel
agsess_     Session
agres_      Reservation
agprice_    PriceRule
agusg_      UsageEvent
agled_      LedgerEntry
agcp_       Control Principal / token family
agrb_       Role Binding
agaud_      Audit Event
req_        request correlation id
```

Identifiers are opaque to clients.
