# Changelog

## 0.2.0 - 2026-09-12

### Reframed

- Repositioned the repository as an independent open-source Agent API Gateway / SaaS control plane, not a caller-product integration layer.
- Defined Session + Execution + Billing as the core architecture.

### Architecture

- Split Provider identity from routable Channel identity.
- Added gateway-owned stable `agsess_*` session IDs.
- Added tenant-aware Session Binding and strict session affinity.
- Added Virtual Key authentication context.
- Moved the Data Plane to the OpenAI Agents API-shaped `/agents/sessions` surface.
- Added gateway routing headers for provider/channel/capability/budget policy.
- Added event submission and event streaming through pinned channels.
- Preserved provider-native session fields while rewriting the public session identity.

### Documentation

- Added full product specification.
- Added domain ontology and invariants.
- Added Data Plane / Control Plane API specification.
- Added metering, reservation, settlement and reconciliation model.
- Reworked provider plugin documentation around Provider vs Channel.
- Removed product-specific integration documentation from the gateway domain.

## 0.1.0

- Initial provider-agnostic Agent Runtime Gateway skeleton.
- Added provider registry, OpenAI adapter, mock provider, SDK skeleton and basic session routing.
