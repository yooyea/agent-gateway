# Providers, Channels and Credentials

This document defines the durable runtime-supply model and the secret-handling boundary.

## 1. Resource model

```text
Provider 1 --- N Channel
Provider 1 --- N Credential
Channel 0..1 --- 1 Credential
```

A **Provider** is an adapter/runtime type such as `openai-agents`.

A **Channel** is one routable instance of that Provider. It owns routing metadata such as enabled state, priority, weight and non-secret provider configuration.

A **Credential** is secret material used by one Provider. A Channel may reference one Credential. Database constraints require the Channel and Credential to belong to the same Provider.

Provider identity, routing configuration and secret material are intentionally separate resources.

## 2. Runtime loading

With Postgres enabled, `gateway_providers`, `gateway_channels` and `gateway_credentials` are the source of truth.

The server maintains a trusted mapping from Provider type to an installed provider module. A database row cannot name an arbitrary module path. Built-in mappings include:

```text
openai-agents -> @agent-gateway/provider-openai-agents
mock          -> @agent-gateway/provider-mock
```

Trusted deployments may extend this map through `AGENT_GATEWAY_PROVIDER_PLUGINS`.

For each persisted Channel the server:

1. resolves the trusted Provider plugin,
2. decrypts the referenced Credential, if any,
3. merges Provider config, Channel config and Credential payload,
4. instantiates the Provider adapter,
5. registers the Channel with its enabled/priority/weight metadata.

Control-plane mutations rebuild the in-process registry. Channel IDs remain stable, so existing SessionBindings continue to resolve through the same Channel identity.

A disabled Channel stays registered for bound-session resolution but is excluded from new-session selection.

## 3. Plaintext config boundary

Provider and Channel `config` fields are queryable non-secret configuration.

Secret-like keys are rejected from plaintext config. Examples include variants of:

```text
apiKey
accessToken
refreshToken
secret
clientSecret
password
authorization
credential
```

Secrets belong in a Credential payload.

## 4. Credential encryption

Credential payloads use an authenticated envelope:

```text
version:    1
algorithm:  aes-256-gcm
keyId:      master-key identifier
iv:         random 96-bit IV
ciphertext: encrypted JSON payload
tag:        GCM authentication tag
```

Every encryption uses a fresh random IV.

Additional authenticated data binds a ciphertext to both the Credential and Provider identity:

```text
agent-gateway:credential:{credentialId}:provider:{providerId}
```

Moving the encrypted payload to a different Credential or Provider therefore fails authentication.

Postgres stores only the encrypted envelope and encryption metadata. Master encryption keys are never persisted in the database.

## 5. Master-key configuration

Keys are supplied by the runtime environment:

```bash
AGENT_GATEWAY_CREDENTIAL_KEYS='{"2026-01":"<base64-32-byte-key>","2026-09":"<base64-32-byte-key>"}'
AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID=2026-09
```

Each value must decode to exactly 32 bytes.

All keys in the keyring may decrypt existing records. Only the active key is used for new encryption.

Production fails closed when an explicit credential keyring is not configured.

The same authenticated keyring also protects completed Control Plane idempotency replay envelopes because those responses may contain one-time Principal or Virtual Key secrets. Credential ciphertext and replay-envelope ciphertext therefore share one key-retention domain.

## 6. Master-key rotation

Rotation is intentionally two-phase:

1. Add the new master key to `AGENT_GATEWAY_CREDENTIAL_KEYS` while retaining the old key.
2. Set `AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID` to the new key.
3. Restart/reload gateway processes with the expanded keyring.
4. Rewrap each Credential through:

```http
POST /api/gateway/admin/credentials/{credential_id}/rewrap
```

5. Verify persisted Credentials reference the new `encryption_key_id`.
6. Keep the old key available until no unexpired Control Plane idempotency replay envelope can require it.
7. Purge expired Control Plane idempotency records, then remove the old key only after both retention conditions are true.

Rewrap decrypts with the original key and immediately encrypts with the active key. The provider secret itself is unchanged.

A Credential rewrap does **not** rewrap already completed idempotency replay envelopes. Consequently, after the old key stops being active it must remain in the runtime keyring for at least the maximum completed replay TTL (`AGENT_GATEWAY_IDEMPOTENCY_TTL_SECONDS`, default 86400 seconds) since the last envelope could have been encrypted with that key.

Safe key removal invariant:

```text
no Credential references the old key
AND
no unexpired Control Plane replay envelope can require the old key
```

Removing the key earlier can make an otherwise valid idempotent retry unable to replay the original one-time secret response.

## 7. Provider-secret rotation

Changing the upstream secret is distinct from rotating the gateway master key.

Replace the Credential payload through:

```http
PATCH /api/gateway/admin/credentials/{credential_id}
```

with a new `payload` object. The payload is encrypted with the currently active master key and the runtime registry is rebuilt.

## 8. Idempotency replay retention

Completed Control Plane replay bodies are encrypted with the Credential keyring and kept only until their completion TTL. The runtime opportunistically cleans expired rows on mutations and also exposes a bounded purge operation in the persistence layer for maintenance/tests.

Replay records are not Credentials, but they can contain secret-bearing responses, so key-retirement procedures must account for them exactly as they account for Credential ciphertext.

## 9. Redaction rules

Control-plane list responses expose Credential metadata only:

- id
- provider id
- name / kind
- encryption key id
- algorithm
- timestamps

They never return `encrypted_payload`, decrypted secret values or master keys.

Application logs, traces and audit events must follow the same rule.

## 10. Session-affinity consequence

Credential or Channel changes affect the adapter registered under a stable Channel ID. They do not authorize silently moving an existing SessionBinding to another Channel.

Disabling a Channel prevents new Session assignment, but an already-bound Session still resolves to that Channel. Explicit migration semantics are required for any future cross-Channel handoff.
