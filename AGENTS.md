# AGENTS.md

## Mission
Build a product-neutral gateway for heterogeneous Agent APIs. OpenAI Agents API is one provider, never the architecture itself.

## Non-negotiable architecture rules
- Product code must not import provider SDKs directly.
- Provider-specific behavior stays inside provider packages.
- Route by declared capabilities; never silently degrade a required capability.
- Preserve vendor-native power through explicit `vendor`/`raw` escape hatches.
- Distinguish native capabilities from emulated capabilities.
- Session identity exposed to products must remain stable even if provider internals change.
- Secrets stay server-side.
- Every mutating request should become idempotent before production use.
- Streaming/event semantics are part of the protocol, not UI implementation detail.

## Evolution rules
When the gateway gains a new provider or capability:
1. Update protocol docs and capability taxonomy.
2. Add or update provider contract tests.
3. Document mapping and any semantic loss.
4. Add changelog entry.
5. Keep LineHalo-specific logic outside this repository.
