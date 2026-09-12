# Provider Plugin and Channel Contract

## 1. Provider vs Channel

A Provider plugin implements the technical translation for one class of agent runtime.

A Channel is a configured instance of that Provider with its own credentials, endpoint, priority, weight and operational state.

The same plugin can back many Channels.

## 2. Provider contract

A provider implements `AgentProvider` from `@agent-gateway/protocol`.

Required operations:

- `capabilities()` — truthful supported/native/emulated feature declaration
- `health()` — configuration/connectivity readiness
- `createSession()` — create a provider-native session
- `getSession()` — retrieve provider-native session state
- `sendEvents()` — submit provider session input/events
- `streamEvents()` — optional event-stream source

Provider code owns vendor translation. Core routing code must never import a vendor SDK.

## 3. Raw/native fields

Provider adapters should retain provider-native session fields under the `raw` representation returned to core.

Core rewrites the public session ID and appends gateway routing metadata. It should not destroy native fields merely to force every provider into a lowest-common-denominator response.

## 4. Capability truth

Capabilities must distinguish:

- `native`: provider implements the behavior itself
- `emulated`: gateway/adapter synthesizes behavior with known semantics
- unsupported: absent

A required unsupported capability causes routing failure.

## 5. Adding a provider

1. Create `packages/provider-<name>`.
2. Implement `AgentProvider`.
3. Add native/emulated capability declarations.
4. Add provider contract tests.
5. Configure one or more Channels using the plugin module.
6. Document semantic differences and provider-specific restrictions.
7. Verify session creation, retrieval, event submission, streaming and usage mapping.
8. Update ontology/architecture if the provider exposes a concept the current model cannot represent.

## 6. Channel example

```json
{
  "id": "openai-primary",
  "module": "@agent-gateway/provider-openai-agents",
  "enabled": true,
  "priority": 100,
  "weight": 100,
  "config": {
    "baseUrl": "https://api.openai.com/v1"
  }
}
```

Secret values should come from a secret store/environment reference rather than committed JSON.
