# LineHalo Integration

LineHalo should depend on the gateway contract, never on a vendor Agent API.

For AI-created indicators/drawings, LineHalo can request capabilities such as:

```json
{
  "requiredCapabilities": ["durable_session", "sandbox", "files", "artifacts"],
  "agent": {
    "instructions": "Create, run, test, fix and verify a LineHalo plugin. Do not finish until validation passes."
  },
  "metadata": {
    "product": "linehalo",
    "workflow": "plugin-generation"
  }
}
```

A future policy/router can additionally choose by price, latency, geography, model family, tenant allow-list, observed success rate and workload type.

Recommended LineHalo flow:

```text
User intent
  -> LineHalo orchestration
  -> Agent Gateway session
  -> Provider agent
  -> sandbox + market-data test fixture
  -> generate plugin
  -> run protocol tests
  -> render/verify
  -> repair loop
  -> artifact / install candidate
  -> LineHalo approval + installation
```

The gateway is infrastructure. LineHalo owns domain policy, chart/plugin validation and user experience.
