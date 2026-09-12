import assert from "node:assert/strict";
import test from "node:test";
import { CredentialKeyring, credentialContext } from "./index.js";

const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");

test("credential payload encrypts, authenticates context and rewraps to the active key", () => {
  const context = credentialContext("cred_1", "provider_1");
  const first = new CredentialKeyring({ old: keyA, next: keyB }, "old");
  const encrypted = first.encrypt({ apiKey: "sk-secret", nested: { token: "hidden" } }, context);
  assert.equal(encrypted.keyId, "old");
  assert.ok(!encrypted.envelope.includes("sk-secret"));
  assert.deepEqual(first.decrypt(encrypted.envelope, context), {
    apiKey: "sk-secret",
    nested: { token: "hidden" },
  });
  assert.throws(() => first.decrypt(encrypted.envelope, credentialContext("cred_2", "provider_1")));

  const rotated = new CredentialKeyring({ old: keyA, next: keyB }, "next");
  const rewrapped = rotated.rewrap(encrypted.envelope, context);
  assert.equal(rewrapped.keyId, "next");
  assert.deepEqual(rotated.decrypt(rewrapped.envelope, context), {
    apiKey: "sk-secret",
    nested: { token: "hidden" },
  });
});

test("missing encryption keys fail closed", () => {
  assert.throws(() => new CredentialKeyring({ bad: Buffer.alloc(31).toString("base64") }, "bad"));
  assert.throws(() => new CredentialKeyring({ old: keyA }, "missing"));
});
