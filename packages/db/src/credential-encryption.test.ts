import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  CredentialEncryptionError,
  decodeMasterKey,
  decryptCredential,
  encryptCredential,
  hashGrantedScopes,
  scopeHashesMatch,
  type CredentialEncryptionContext,
} from "./credential-encryption.js";

const masterKey = randomBytes(32);
const rotatedKey = randomBytes(32);
const token = "IGAAasyntheticaccesstokenvaluethatmustneverpersistinplaintext";

const context: CredentialEncryptionContext = {
  accountId: "0192f2a0-0000-7000-8000-000000000001",
  integrationType: "INSTAGRAM",
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

function seal(overrides: Partial<Parameters<typeof encryptCredential>[0]> = {}) {
  return encryptCredential({ context, keyVersion: 1, masterKey, plaintext: token, ...overrides });
}

describe("credential envelope encryption", () => {
  it("round-trips the credential and records the key version", () => {
    const sealed = seal();

    expect(sealed.keyVersion).toBe(1);
    expect(
      decryptCredential({
        context,
        masterKeys: new Map([[1, masterKey]]),
        sealed: sealed.ciphertext,
      }),
    ).toBe(token);
  });

  it("never exposes the plaintext or the master key in the ciphertext", () => {
    const sealed = seal();

    expect(sealed.ciphertext).not.toContain(token);
    expect(sealed.ciphertext).not.toContain(masterKey.toString("base64"));
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain(token);
  });

  it("produces a distinct ciphertext for identical input so rows are not comparable", () => {
    // A deterministic ciphertext would let equal tokens be identified by value,
    // and would make ciphertext usable as an idempotency input.
    expect(seal().ciphertext).not.toBe(seal().ciphertext);
  });

  it("refuses a ciphertext moved to another workspace, integration or account", () => {
    const sealed = seal();
    const keys = new Map([[1, masterKey]]);

    for (const mutation of [
      { workspaceId: "0192f2a0-0000-7000-8000-0000000000aa" },
      { integrationType: "FACEBOOK" },
      { accountId: "0192f2a0-0000-7000-8000-000000000002" },
    ]) {
      expect(() =>
        decryptCredential({
          context: { ...context, ...mutation },
          masterKeys: keys,
          sealed: sealed.ciphertext,
        }),
      ).toThrow(CredentialEncryptionError);
    }
  });

  it("refuses a ciphertext sealed under a different master key", () => {
    const sealed = seal();

    expect(() =>
      decryptCredential({
        context,
        masterKeys: new Map([[1, rotatedKey]]),
        sealed: sealed.ciphertext,
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: "AUTHENTICATION_FAILED" }));
  });

  it("reports an unavailable key version rather than attempting another key", () => {
    const sealed = seal({ keyVersion: 7 });

    expect(() =>
      decryptCredential({
        context,
        masterKeys: new Map([[1, masterKey]]),
        sealed: sealed.ciphertext,
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: "KEY_VERSION_UNAVAILABLE" }));
  });

  it("supports rotation by holding several key versions at once", () => {
    const old = seal({ keyVersion: 1 });
    const rotated = seal({ keyVersion: 2, masterKey: rotatedKey });
    const keys = new Map([
      [1, masterKey],
      [2, rotatedKey],
    ]);

    expect(decryptCredential({ context, masterKeys: keys, sealed: old.ciphertext })).toBe(token);
    expect(decryptCredential({ context, masterKeys: keys, sealed: rotated.ciphertext })).toBe(
      token,
    );
  });

  it("rejects tampering with any envelope segment", () => {
    const sealed = seal();
    const keys = new Map([[1, masterKey]]);
    const envelope = Buffer.from(sealed.ciphertext, "base64");

    // Flip a bit in the wrapped key, the payload tag and the ciphertext body.
    for (const offset of [20, envelope.length - 40, envelope.length - 1]) {
      const tampered = Buffer.from(envelope);
      tampered.writeUInt8(tampered.readUInt8(offset) ^ 0x01, offset);
      expect(() =>
        decryptCredential({ context, masterKeys: keys, sealed: tampered.toString("base64") }),
      ).toThrow(CredentialEncryptionError);
    }
  });

  it("rejects a malformed or truncated envelope and an unsupported format version", () => {
    const keys = new Map([[1, masterKey]]);

    expect(() => decryptCredential({ context, masterKeys: keys, sealed: "" })).toThrowError(
      expect.objectContaining({ reasonCode: "ENVELOPE_MALFORMED" }),
    );

    const truncated = Buffer.from(seal().ciphertext, "base64").subarray(0, 40);
    expect(() =>
      decryptCredential({ context, masterKeys: keys, sealed: truncated.toString("base64") }),
    ).toThrowError(expect.objectContaining({ reasonCode: "ENVELOPE_MALFORMED" }));

    const wrongVersion = Buffer.from(seal().ciphertext, "base64");
    wrongVersion.writeUInt8(9, 0);
    expect(() =>
      decryptCredential({ context, masterKeys: keys, sealed: wrongVersion.toString("base64") }),
    ).toThrowError(expect.objectContaining({ reasonCode: "ENVELOPE_VERSION_UNSUPPORTED" }));
  });

  it("fails closed on an invalid master key length, key version or empty plaintext", () => {
    expect(() => seal({ masterKey: randomBytes(16) })).toThrowError(
      expect.objectContaining({ reasonCode: "MASTER_KEY_LENGTH_INVALID" }),
    );
    expect(() => seal({ keyVersion: 0 })).toThrowError(
      expect.objectContaining({ reasonCode: "KEY_VERSION_INVALID" }),
    );
    expect(() => seal({ plaintext: "" })).toThrowError(
      expect.objectContaining({ reasonCode: "PLAINTEXT_EMPTY" }),
    );
    expect(() => decodeMasterKey(randomBytes(31).toString("base64"))).toThrow(
      CredentialEncryptionError,
    );
  });

  it("keeps key material out of error messages", () => {
    try {
      seal({ masterKey: randomBytes(16) });
      expect.unreachable("expected a CredentialEncryptionError");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(token);
      expect(message).not.toContain(masterKey.toString("base64"));
    }
  });
});

describe("granted scope hashing", () => {
  it("is order and duplicate insensitive so a reordered grant is not a downgrade", () => {
    const left = hashGrantedScopes([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);
    const right = hashGrantedScopes([
      "instagram_business_manage_insights",
      " instagram_business_basic ",
      "instagram_business_basic",
    ]);

    expect(left).toBe(right);
    expect(scopeHashesMatch(left, right)).toBe(true);
  });

  it("detects a dropped scope", () => {
    const granted = hashGrantedScopes([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);
    const downgraded = hashGrantedScopes(["instagram_business_basic"]);

    expect(scopeHashesMatch(granted, downgraded)).toBe(false);
  });

  it("does not reveal the scope names in the hash", () => {
    const hash = hashGrantedScopes(["instagram_business_basic"]);

    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash).not.toContain("instagram");
  });
});
