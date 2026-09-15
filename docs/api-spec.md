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
- If the caller omits max cost and the active PlanVersion defines `default_session_budget_micros`, that exact value becomes the Session budget.
- A caller-explicit max cost wins over the Plan default.

Billing activation:

- Tenant without BillingAccount: unbilled/legacy path.
- enabled BillingAccount: hard max-cost budget required; an active Plan default may satisfy this requirement.
- disabled BillingAccount: billed work rejected.

Creation order:

```text
VirtualKey -> Tenant
  -> resolve active CommercialPolicy
  -> resolve effective Session budget
  -> select Channel
  -> allocate agsess_...
  -> persist SessionBinding(state=creating)
  -> if billed: reserve exact max-cost capacity
  -> attach Reservation
  -> call Provider createSession
  -> persist bound | failed
```

Only failures known to occur before Provider invocation may safely release the pre-provider financial hold. Once Provider invocation may have begun, generic binding/provider failure is treated as potentially side-effecting and the hold remains until reconciliation/expiry handling.

The effective Session budget is persisted with the Session. Later Plan/subscription changes do not rewrite an existing Session budget.

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
resolve current CommercialPolicy admission limits
  -> retrieve provider Session
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

Provider streams are currently opaque bytes. v0.5-v0.7 therefore reconcile cumulative usage after stream completion; precise mid-stream cutoff requires incremental provider usage observability.

## 7. Runtime commercial admission

For every authenticated Data Plane request, the gateway resolves the Tenant's current CommercialPolicy.

An active PlanVersion may define:

- `requests_per_minute`
- `max_concurrency`
- `default_session_budget_micros`

Runtime semantics:

- Plan RPM overrides the environment RPM fallback when present.
- Plan max concurrency overrides the environment concurrency fallback when present.
- Missing Plan values fall back to the environment defaults.
- Session budget default is applied only during new Session creation when the caller did not explicitly declare a budget.
- Included credits are not yet spendable from CommercialPolicy alone; see the CreditBucket boundary in `docs/commercial.md`.

Rate/concurrency rejection remains HTTP 429 using the existing gateway limit headers.

## 8. Billing admission errors

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

## 9. Runtime Channel view

```http
GET /api/gateway/channels
Authorization: Bearer ag_xxx
```

Returns Channel runtime/circuit health without Credential material.

## 10. Control Plane permissions

The authoritative permission vocabulary and role mapping live in `@agent-gateway/control-plane-auth`. Domain handlers do not maintain independent role policy.

Core permissions:

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

Billing permissions:

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

Commercial permissions:

```text
commercial.plans.read
commercial.plans.write
commercial.subscriptions.read
commercial.subscriptions.write
commercial.policy.read
```

Role bundles:

- `owner`: all permissions.
- `admin`: all operational, Billing and Commercial permissions except `rbac.manage`.
- `operator`: operational permissions plus Billing/Commercial reads only.
- `viewer`: read permissions including Billing/Commercial reads.

Role Bindings are `global` or `tenant` scoped.

Provider, Credential, Channel, RBAC, Plan and PlanVersion resources are gateway-global. Project, Virtual Key, Billing Tenant, Subscription and CommercialPolicy resources may carry Tenant scope.

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

### Read exposure

```http
GET /api/gateway/admin/billing/accounts/{tenant_id}/exposure
```

Permission: `billing.accounts.read`.

## 12. PriceRule API

### List rules

```http
GET /api/gateway/admin/billing/price-rules?tenant_id=tenant_...
```

Permission: `billing.pricing.read`.

A Tenant-scoped caller must provide its matching `tenant_id` and receives only PriceRules explicitly owned by that Tenant. Raw global PriceRule rows require global authorization.

### Create rule

```http
POST /api/gateway/admin/billing/price-rules
Idempotency-Key: caller-generated-key
```

Permission: `billing.pricing.write`.

New pricing is represented by new effective-dated rules rather than in-place historical mutation.

## 13. Credit API

```http
POST /api/gateway/admin/billing/credits
Idempotency-Key: caller-generated-key
```

Permission: `billing.credits.write`.

The operation appends an immutable customer Ledger entry with kind `credit.grant`.

## 14. Financial read APIs

```text
GET /api/gateway/admin/billing/usage
GET /api/gateway/admin/billing/ledger
GET /api/gateway/admin/billing/reservations
```

Tenant-scoped callers must query their Tenant. Omitting `tenant_id` is a global/unfiltered read and requires a global binding. These reads are audited.

## 15. Commercial Plan APIs

### List/create Plans

```text
GET  /api/gateway/admin/commercial/plans
POST /api/gateway/admin/commercial/plans
```

Plan resources are global. Create requires `Idempotency-Key` and `commercial.plans.write` with global scope.

### List/create PlanVersions

```text
GET  /api/gateway/admin/commercial/plans/{plan_id}/versions
POST /api/gateway/admin/commercial/plans/{plan_id}/versions
```

PlanVersion is immutable after creation. Example create body:

```json
{
  "billing_interval": "month",
  "recurring_price_micros": "20000000",
  "included_credit_micros": "5000000",
  "default_session_budget_micros": "2000000",
  "requests_per_minute": 600,
  "max_concurrency": 40,
  "entitlements": { "sandbox": true },
  "effective_from": "2026-09-15T00:00:00Z"
}
```

Commercial money fields are exact integer USD micros. A new commercial offer creates a new PlanVersion instead of changing an existing one.

## 16. Subscription and CommercialPolicy APIs

```text
GET  /api/gateway/admin/commercial/subscriptions?tenant_id=tenant_...
POST /api/gateway/admin/commercial/subscriptions
POST /api/gateway/admin/commercial/subscriptions/{subscription_id}/cancel
GET  /api/gateway/admin/commercial/policy?tenant_id=tenant_...
```

Subscription and policy operations carry Tenant scope. Unfiltered subscription listing requires global authorization.

Subscription create body identifies an exact `plan_version_id` plus optional start/end timestamps. A Tenant cannot have overlapping scheduled/active subscription intervals.

Policy response is the resolved runtime view for the active subscription and includes Plan/PlanVersion/Subscription identity, current period, default Session budget, RPM, concurrency, included-credit entitlement and non-secret entitlements.

Every Commercial mutation requires `Idempotency-Key`. Mutation + success AuditEvent + encrypted replay completion commit atomically in the existing Control Plane transaction.

## 17. Billing mutation idempotency and atomicity

Every Billing Control Plane mutation requires `Idempotency-Key`. Missing/invalid management idempotency headers are authenticated mutation failures and produce `outcome=error` AuditEvents.

A successful financial mutation is one durable transaction:

```text
financial mutation
+ success AuditEvent
+ completed encrypted idempotency record
= one Postgres commit
```

Credit grant adds a permanent immutable-Ledger identity including the semantic request fingerprint so a reclaimed management key cannot resolve to a different historical credit.

## 18. Tenant / Project / Virtual Key Control Plane

```text
POST /api/gateway/admin/tenants
POST /api/gateway/admin/projects
POST /api/gateway/admin/virtual-keys
```

Virtual Key plaintext is returned exactly once; durable storage keeps hash + display prefix.

## 19. Provider / Credential / Channel Control Plane

```text
GET/POST/PATCH /api/gateway/admin/providers...
GET/POST/PATCH /api/gateway/admin/credentials...
GET/POST/PATCH /api/gateway/admin/channels...
```

Credential payloads are encrypted and never returned. Channel may reference only a Credential owned by the same Provider. Runtime registry rebuild happens after durable Control Plane commit.

## 20. Principals / Role Bindings / Audit

```text
GET/POST/PATCH /api/gateway/admin/principals...
GET/POST/DELETE /api/gateway/admin/role-bindings...
GET /api/gateway/admin/audit
```

Audit supports actor/resource/Tenant/outcome filters and is append-only.

## 21. Error model

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
- `409`: idempotency, duplicate, subscription overlap, FK/ownership or state conflict.
- `429`: rate/concurrency/session-budget admission failure.
- `502/503`: Provider/Channel/infrastructure or required pricing unavailable.

## 22. Data Plane idempotency

Session creation HTTP idempotency scope:

```text
Tenant + VirtualKey + operation + Idempotency-Key
```

The fingerprint includes the body, routing/capability hints and the **effective** normalized exact Session budget after CommercialPolicy defaulting.

A pending claim is released only for failures known to occur before Provider invocation. Potentially side-effecting failures remain pending to prevent duplicate Agent Sessions and duplicate spend.

## 23. Identifier prefixes

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
agplan_     Plan
agplanv_    PlanVersion
agsub_      Subscription
agcp_       Control Principal / token family
agrb_       Role Binding
agaud_      Audit Event
req_        request correlation id
```

Identifiers are opaque to clients.
