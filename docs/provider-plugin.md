# Provider Plugin Contract

A provider implements `AgentProvider` from `@agent-gateway/protocol`.

Required operations:

- `capabilities()` — what this provider can actually do.
- `health()` — configuration/connectivity readiness.
- `createSession()` — creates a provider-native durable or emulated session.
- `getSession()` — maps native state to canonical session state.
- `sendInput()` — submits a user turn/event.
- `cancel()` — optional if the backend supports cancellation.

Provider code owns all translation between the canonical protocol and vendor details. Core routing code must never import a vendor SDK.

## Escape hatch

`AgentDefinition.vendor` exists deliberately. A new provider capability does not need to wait for the canonical protocol to evolve. Product code should prefer canonical fields, while experimental/provider-specific knobs may pass through `vendor`.

## Adding a provider

1. Create `packages/provider-<name>`.
2. Implement `AgentProvider`.
3. Add capability declarations.
4. Add contract tests using the shared protocol fixtures.
5. Register the plugin in server configuration.
6. Document native vs emulated behavior.
