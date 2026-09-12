# Agent Gateway

A provider-agnostic **Agent Runtime Gateway** for products that need to use multiple Agents APIs without coupling themselves to one vendor.

OpenAI Agents API is the first real provider. The architecture is deliberately plugin-based so Claude, Gemini, self-hosted harnesses, or future agent runtimes can be added without changing LineHalo or other products.

## Why

Model gateways normalize `chat/completions`. Agent gateways need to normalize much more: durable sessions, runtime environments, events, tools, MCP, artifacts, approvals, subagents, files, secrets and cancellation.

The gateway therefore uses **capability negotiation**, not a lowest-common-denominator API.

## Repository layout

```text
apps/server                    HTTP gateway
packages/protocol              canonical Agent Runtime Protocol
packages/core                  provider registry + capability router
packages/provider-openai-agents OpenAI Agents API adapter
packages/provider-mock         local/test provider
packages/sdk                   product-facing TypeScript SDK
docs/                          architecture + integration docs
```

## Quick start

```bash
cp .env.example .env
npm install
npm run build
OPENAI_API_KEY=... npm start
```

List providers:

```bash
curl http://localhost:8787/v1/providers
```

Create a session:

```bash
curl -X POST http://localhost:8787/v1/sessions \
  -H 'content-type: application/json' \
  -d '{
    "requiredCapabilities":["durable_session","sandbox"],
    "agent":{"instructions":"Build and verify a LineHalo plugin."},
    "environment":{"type":"hosted"},
    "input":"Create an indicator that highlights confirmed breakout retests."
  }'
```

## v0.1 scope

Implemented now:
- canonical session protocol
- runtime-loaded provider plugin registry
- capability-aware selection
- OpenAI Agents API session create/get/input/cancel mapping
- mock provider
- HTTP gateway
- TypeScript SDK skeleton
- LineHalo integration architecture

Next engineering steps:
- persistent session directory
- SSE/WebSocket event normalization
- tool-result / approval round trips
- provider hot reload / zero-downtime refresh
- auth / tenancy / quota / audit
- provider contract test kit
- policies for cost/latency/reliability routing
- additional provider adapters

## OpenAI mapping

The first provider maps to OpenAI's managed Agents API endpoints such as `POST /agents/sessions`, `GET /agents/sessions/{id}`, and `POST /agents/sessions/{id}/events`.

This repository treats those endpoints as one provider implementation rather than the public contract products consume.

## Switching providers

A product may choose a provider explicitly per session or let the gateway route by required capabilities. This gives LineHalo free provider choice without vendor coupling.

The gateway intentionally does **not** pretend that a live durable session can be moved losslessly between vendors. Cross-provider handoff will be a separate migration capability: export canonical task/context/artifacts, create a new provider session, then attach lineage. That keeps semantics explicit instead of hiding state loss.
