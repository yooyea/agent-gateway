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

A Virtual Key resolves to one Tenant and optionally one Project.

Scope rules:

- Tenant-level key may access Sessions across Projects in that Tenant.
- Project-scoped key may access only Sessions with the same durable Project.
- Cross-Tenant / cross-Project Session access is hidden as not found.

### Control Plane

```http
Authorization: Bearer agcp_xxx
```

`AGENT_GATEWAY_ADMIN_TOKEN` is bootstrap / break-glass access only.

Every Control Plane response, including errors, exposes:

```http
X-Request-Id: req_...
```

The same id is used by corresponding AuditEvents.

## 3. Create Session

```http
POST /agents/sessions
Authorization: Bearer ag_...
Idempotency-Key: caller-generated-key
```

Body follows the provider-compatible Agents Session shape.

Gateway routing/admission headers:

```http
X-Agent-Gateway-Provider: openai-agents
X-Agent-Gateway-Channel: openai-primary
X-Agent-Gateway-Required-Capabilities: sandbox,mcp,streaming
X-Agent-Gateway-Max-Cost-USD: 2.00
```

Rules:

- Channel takes precedence over Provider.
- Required capabilities fail closed.
- Max cost must be positive and contain at most six decimal places.
- Max cost is converted directly from decimal text into exact integer USD micros.
- The normalized micros value participates in Session-create idempotency fingerprinting.

Billing activation:

- Tenant without BillingAccount: unbilled/legacy path.
- enabled BillingAccount: hard max-cost budget required.
- disabled BillingAccount: billed work rejected.

Creation order:

```text
select Channel
  -> allocate agsess_...
  -> persist SessionBinding(state=creating)
  -> if billed: reserve exact max-cost capacity
  -> attach Reservation
  -> call Provider createSession
  -> persist bound | failed
```

Only failures known to occur before Provider invocation may safely release the pre-provider financial hold. Once Provider invocation may have begun, generic binding/provider failure is treated as potentially side-effecting and the hold remains until reconciliation/expiry handling.

A completed idempotent replay includes:

```http
X-Agent-Gateway-Idempotent-Replay: true
```

## 4. Retrieve Session

```http
GET /agents/sessions/{gateway_session_id}
```

The gateway resolves the durable SessionBinding and retrieves state from the pinned Channel.

Status retrieval does not require remaining budget because it is used to establish state. Provider usage, when present, may be observed/settled best-effort.

## 5. Submit Session events

```http
POST /agents/sessions/{gateway_session_id}/events
```

Before additional billed Agent work, the gateway executes under an exclusive per-Session runtime lease:

```text
retrieve provider Session
  -> observe cumulative usage
  -> settle delta
  -> fail closed on unresolved customer pricing
  -> renew/reacquire expired Reservation capacity
  -> assert remaining SessionBudget
  -> only then contact Provider
```

The per-Session lease prevents overlapping Agent work from passing the same budget snapshot.

Post-success usage reconciliation is best-effort so a local accounting refresh failure does not turn an already-successful upstream mutation into a retry signal.

## 6. Stream Session events

```http
GET /agents/sessions/{gateway_session_id}/events
Accept: text/event-stream
```

The same Session lease + strict financial preflight runs before stream start.

Provider streams are currently opaque bytes. v0.5/v0.6 therefore reconcile cumulative usage after stream completion; precise mid-stream cutoff requires incremental provider usage observability.

## 7. Billing admission errors

Insufficient Tenant capacity:

```http
402 Payment Required
X-Agent-Gateway-Limit-Type: billing_capacity
X-Agent-Gateway-Available-Micros: ...
X-Agent-Gateway-Requested-Micros: ...
```

Hard budget required:

```http
402 Payment Required
X-Agent-Gateway-Limit-Type: budget_required
```

Billing disabled:

```http
402 Payment Required
X-Agent-Gateway-Limit-Type: billing_disabled
```

Unresolved customer pricing:

```http
503 Service Unavailable
X-Agent-Gateway-Limit-Type: billing_price_unavailable
X-Agent-Gateway-Usage-Event-Id: agusg_...
```

Session budget exhausted:

```http
429 Too Many Requests
X-Agent-Gateway-Limit-Type: budget
X-Agent-Gateway-Budget-Remaining-Micros: 0
```

## 8. Runtime Channel view

```http
GET /api/gateway/channels
Authorization: Bearer ag_xxx
```

Returns Channel runtime/circuit health without Credential material.

## 9. Core Control Plane permissions

Core permission vocabulary:

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

Role Bindings are `global` or `tenant` scoped.

Provider, Credential, Channel and RBAC resources are gateway-global. Project and Virtual Key lifecycle may carry Tenant scope.

## 10. Billing Control Plane permissions

Billing is a governed subdomain with its own permission vocabulary:

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

Role bundles:

- `owner`: all billing permissions.
- `admin`: all billing permissions.
- `operator`: billing reads only.
- `viewer`: billing reads only.

Scope rules:

- global binding may operate across Tenants;
- Tenant binding may operate only on that Tenant;
- global PriceRule operations require global scope;
- unfiltered/cross-Tenant financial reads require global scope.

## 11. BillingAccount API

### Read BillingAccount

```http
GET /api/gateway/admin/billing/accounts/{tenant_id}
```

Permission: `billing.accounts.read` for the Tenant.

### Upsert BillingAccount

```http
PUT /api/gateway/admin/billing/accounts/{tenant_id}
Idempotency-Key: caller-generated-key
```

Permission: `billing.accounts.write`.

Body:

```json
{
  "credit_limit_micros": "10000000",
  "currency": "USD",
  "enabled": true
}
```

`credit_limit_micros` is an integer string. Current implementation supports USD only.

`PUT` is current full account configuration/upsert semantics, not a Ledger credit operation.

### Read exposure

```http
GET /api/gateway/admin/billing/accounts/{tenant_id}/exposure
```

Permission: `billing.accounts.read`.

Response includes:

```json
{
  "account": {},
  "ledger_balance_micros": "1000000",
  "reserved_micros": "250000",
  "available_micros": "10750000"
}
```

## 12. PriceRule API

### List rules

```http
GET /api/gateway/admin/billing/price-rules?tenant_id=tenant_...
```

Permission: `billing.pricing.read`.

A Tenant-scoped caller must provide its matching `tenant_id`. The result may include applicable global rules because they contribute to that Tenant's effective pricing.

Omitting `tenant_id` is a global/unfiltered operation and requires global scope.

### Create rule

```http
POST /api/gateway/admin/billing/price-rules
Idempotency-Key: caller-generated-key
```

Permission: `billing.pricing.write`.

Example:

```json
{
  "tenant_id": "tenant_optional",
  "provider_type": "openai-agents",
  "model": "gpt-example",
  "metric": "model.input_tokens",
  "unit_scale": "1000000",
  "upstream_price_micros": "1250000",
  "customer_price_micros": "1500000",
  "currency": "USD",
  "effective_from": "2026-09-14T00:00:00Z"
}
```

At least one of upstream/customer price is required.

Current metrics:

```text
model.input_tokens
model.cached_input_tokens
model.output_tokens
sandbox.compute_seconds
web_search.call
file_search.call
tool.call
provider.other
```

v0.6 does not expose in-place PriceRule update/delete. New pricing is represented by new effective-dated rules.

A rule without `tenant_id` is global and requires a global RoleBinding.

## 13. Credit API

```http
POST /api/gateway/admin/billing/credits
Idempotency-Key: caller-generated-key
```

Permission: `billing.credits.write`.

Body:

```json
{
  "tenant_id": "tenant_...",
  "amount_micros": "5000000",
  "reason": "manual prepaid credit"
}
```

The operation appends an immutable customer Ledger entry with kind `credit.grant`.

It does not mutate historical Ledger rows.

## 14. Financial read APIs

Usage:

```http
GET /api/gateway/admin/billing/usage?tenant_id=...&session_id=...&limit=100
```

Permission: `billing.usage.read`.

Ledger:

```http
GET /api/gateway/admin/billing/ledger?tenant_id=...&session_id=...&book=customer&limit=100
```

Permission: `billing.ledger.read`.

Reservations:

```http
GET /api/gateway/admin/billing/reservations?tenant_id=...&session_id=...&limit=100
```

Permission: `billing.reservations.read`.

Tenant-scoped callers must query their Tenant. Omitting `tenant_id` is a global/unfiltered read and requires a global binding.

All these reads are audited.

## 15. Billing mutation idempotency and atomicity

Every Billing Control Plane mutation requires:

```http
Idempotency-Key: caller-generated-key
```

Scope:

```text
ControlPrincipal/bootstrap actor + billing action + Idempotency-Key
```

The semantic request is fingerprinted. Completed response replay is encrypted at rest with the gateway Credential keyring.

A successful financial mutation is one durable transaction:

```text
financial mutation
+ success AuditEvent
+ completed encrypted idempotency record
= one Postgres commit
```

On failure, that durable unit rolls back and a separate `outcome=error` AuditEvent is appended after rollback.

A completed replay does not re-run the financial mutation; it returns the original response with:

```http
X-Agent-Gateway-Idempotent-Replay: true
```

and records current-request audit evidence.

Credit Ledger idempotency is further scoped by actor + credit action + Tenant + management key.

## 16. Tenant / Project / Virtual Key Control Plane

```text
POST /api/gateway/admin/tenants
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

Permissions:

- Tenant create: `tenants.write` global.
- Project create: `projects.write` global or matching Tenant scope.
- Virtual Key create: `keys.write` global or matching Tenant scope.

Virtual Key plaintext is returned exactly once; durable storage keeps hash + display prefix.

## 17. Provider / Credential / Channel Control Plane

Providers:

```text
GET   /api/gateway/admin/providers
POST  /api/gateway/admin/providers
PATCH /api/gateway/admin/providers/{provider_id}
```

Credentials:

```text
GET   /api/gateway/admin/credentials
POST  /api/gateway/admin/credentials
PATCH /api/gateway/admin/credentials/{credential_id}
POST  /api/gateway/admin/credentials/{credential_id}/rewrap
```

Channels:

```text
GET   /api/gateway/admin/channels
POST  /api/gateway/admin/channels
PATCH /api/gateway/admin/channels/{channel_id}
```

Credential payloads are encrypted and never returned. Channel may reference only a Credential owned by the same Provider. Runtime registry rebuild happens after durable Control Plane commit.

## 18. Principals / Role Bindings / Audit

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

Audit:

```http
GET /api/gateway/admin/audit
```

Audit supports actor/resource/Tenant/outcome filters and is append-only.

## 19. Error model

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

- `400`: invalid input, exact-money format, routing or scope.
- `401`: invalid/missing Data or Control Plane credential.
- `402`: billed Tenant cannot financially admit new Agent work.
- `403`: authenticated Control Principal lacks permission/scope.
- `404`: scoped resource not found.
- `409`: idempotency, duplicate, FK/ownership or state conflict.
- `429`: rate/concurrency/session-budget admission failure.
- `502/503`: Provider/Channel/infrastructure or required pricing unavailable.

## 20. Data Plane idempotency

Session creation HTTP idempotency scope:

```text
Tenant + VirtualKey + operation + Idempotency-Key
```

The fingerprint includes the body, routing/capability hints and normalized exact Session budget micros.

A pending claim is released only for failures known to occur before Provider invocation. Potentially side-effecting failures remain pending to prevent duplicate Agent Sessions and duplicate spend.

Session event body `idempotency_key` remains provider-compatible.

## 21. Identifier prefixes

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
