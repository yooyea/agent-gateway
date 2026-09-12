# Redis Runtime Controls

## Purpose

Redis stores **operational state**, not durable business or financial truth.

```text
Postgres
  Tenant / Project / VirtualKey
  SessionBinding
  Idempotency
  future Usage / Ledger / Audit

Redis
  rate-limit windows
  concurrency leases
  hot Session cache
  Channel circuit state
```

A Redis restart may reset operational protection windows and caches, but it must never erase a durable Session Binding or financial record.

## Rate limiting

The data plane applies a fixed-window limit scoped to the authenticated Virtual Key identity.

Default development policy:

```text
120 requests / 60 seconds
```

Configuration:

```text
AGENT_GATEWAY_RATE_LIMIT_REQUESTS
AGENT_GATEWAY_RATE_LIMIT_WINDOW_SECONDS
```

The counter update and expiry initialization execute in one Lua script. A denied request returns HTTP `429` with `Retry-After` and `x-agent-gateway-limit-type: rate`.

Idempotent replay still consumes request-rate capacity because it is a real gateway request, but it does not consume upstream concurrency because no provider request is executed.

## Concurrency leases

Concurrency protects upstream execution capacity and spend rather than HTTP connection count.

Each accepted upstream operation receives a lease stored in a Redis sorted set:

```text
member = random lease id
score  = expires_at epoch milliseconds
```

Before admission, expired leases are removed atomically. If the remaining cardinality is already at the configured limit, the request is rejected with `429`.

Configuration:

```text
AGENT_GATEWAY_MAX_CONCURRENCY
AGENT_GATEWAY_CONCURRENCY_LEASE_SECONDS
```

The lease has both explicit release and TTL-based crash recovery. While a request is alive, the server renews the lease approximately every third of the lease duration. This matters for long-running SSE streams and agent executions.

If a process crashes, renewal stops and the lease naturally disappears after its TTL.

## Hot Session cache

`RedisCachedSessionStore` decorates an existing durable `SessionStore`.

Write path:

```text
write durable store
      |
      v
write Redis cache best effort
```

Read path:

```text
Redis hit -> return
Redis miss/error -> durable store -> refill Redis best effort
```

The durable write always happens first. Redis failure therefore cannot make a successful durable update disappear.

Configuration:

```text
AGENT_GATEWAY_SESSION_CACHE_TTL_SECONDS
```

## Channel circuit breaker

Each Channel has two ephemeral keys:

```text
failure counter with failure-window TTL
open-circuit key with open TTL
```

After the configured number of failures inside the failure window, the Channel opens for a short period.

Configuration:

```text
AGENT_GATEWAY_CIRCUIT_FAILURE_THRESHOLD
AGENT_GATEWAY_CIRCUIT_FAILURE_WINDOW_SECONDS
AGENT_GATEWAY_CIRCUIT_OPEN_SECONDS
```

A provider success clears both failure and open state.

### Critical affinity rule

Circuit state participates only in **new Session selection**.

An existing SessionBinding:

```text
agsess_x -> channel_a -> provider_session_y
```

continues to resolve to `channel_a` even when `channel_a` later opens its circuit. The gateway must surface an error/degraded state rather than transparently reroute that live Session to another Channel.

This preserves provider-native durable state and prevents hidden state loss.

## Failure semantics

Session cache operations fail open to the durable store because cache availability is not a correctness requirement.

Rate limiting and concurrency admission use Redis as an enforcement dependency. When Redis is configured but unavailable, those operations fail rather than silently allowing unbounded upstream work.

Circuit telemetry is best effort inside the core routing layer. Failure to record circuit state must not replace the original provider response/error.

## Production requirement

Production mode requires `REDIS_URL` in addition to `DATABASE_URL`.

Local development may omit `REDIS_URL`; in that mode rate limiting, concurrency admission, hot cache and circuit state are disabled.
