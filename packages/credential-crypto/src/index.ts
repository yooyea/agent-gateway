import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CredentialEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedCredential {
  envelope: string;
  keyId: string;
  algorithm: "aes-256-gcm";
}

function decodeKey(value: string) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Credential encryption keys must decode to exactly 32 bytes");
  return key;
}

export class CredentialKeyring {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    keys: Record<string, string>,
    readonly activeKeyId: string,
  ) {
    for (const [id, value] of Object.entries(keys)) {
      if (!id.trim()) throw new Error("Credential encryption key id must not be empty");
      this.keys.set(id, decodeKey(value));
    }
    if (!this.keys.size) throw new Error("At least one credential encryption key is required");
    if (!this.keys.has(activeKeyId)) throw new Error(`Active credential key is not present: ${activeKeyId}`);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env) {
    const raw = env.AGENT_GATEWAY_CREDENTIAL_KEYS;
    const activeKeyId = env.AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID;
    if (!raw || !activeKeyId) {
      throw new Error("AGENT_GATEWAY_CREDENTIAL_KEYS and AGENT_GATEWAY_ACTIVE_CREDENTIAL_KEY_ID are required");
    }
    const parsed = JSON.parse(raw) as Record<string, string>;
    return new CredentialKeyring(parsed, activeKeyId);
  }

  hasKey(id: string) {
    return this.keys.has(id);
  }

  encrypt(payload: Record<string, unknown>, context: string): EncryptedCredential {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope: CredentialEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      keyId: this.activeKeyId,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    return {
      envelope: JSON.stringify(envelope),
      keyId: envelope.keyId,
      algorithm: envelope.algorithm,
    };
  }

  decrypt<T extends Record<string, unknown> = Record<string, unknown>>(serialized: string, context: string): T {
    const envelope = JSON.parse(serialized) as CredentialEnvelope;
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
      throw new Error("Unsupported credential envelope");
    }
    const key = this.keys.get(envelope.keyId);
    if (!key) throw new Error(`Credential encryption key is unavailable: ${envelope.keyId}`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Credential payload must decode to an object");
    }
    return parsed as T;
  }

  rewrap(serialized: string, context: string): EncryptedCredential {
    return this.encrypt(this.decrypt(serialized, context), context);
  }
}

export function credentialContext(credentialId: string, providerId: string) {
  return `agent-gateway:credential:${credentialId}:provider:${providerId}`;
}
