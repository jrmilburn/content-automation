import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for integration credential material.
 *
 * A fresh 256-bit data encryption key (DEK) protects each credential, and the
 * DEK is itself wrapped with the environment master key (KEK). Rotating the
 * master key therefore only requires re-wrapping DEKs, and the stored key
 * version records which master key a row was sealed under.
 *
 * Both the wrap and the payload are bound to an authenticated context string,
 * so a ciphertext cannot be relocated to another workspace, integration or
 * account row and still decrypt. The module never loads configuration and never
 * logs, so key material cannot leak through it.
 */

const FORMAT_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const HEADER_BYTES = 1 + 4; // format version + key version
const WRAPPED_OFFSET = HEADER_BYTES + IV_BYTES;
const WRAPPED_TAG_OFFSET = WRAPPED_OFFSET + KEY_BYTES;
const PAYLOAD_IV_OFFSET = WRAPPED_TAG_OFFSET + TAG_BYTES;
const PAYLOAD_TAG_OFFSET = PAYLOAD_IV_OFFSET + IV_BYTES;
const CIPHERTEXT_OFFSET = PAYLOAD_TAG_OFFSET + TAG_BYTES;

/** Identifies the row a ciphertext belongs to; mismatches fail to decrypt. */
export type CredentialEncryptionContext = Readonly<{
  accountId: string;
  integrationType: string;
  workspaceId: string;
}>;

export type SealedCredential = Readonly<{
  ciphertext: string;
  keyVersion: number;
}>;

/** Carries no plaintext, key material or provider detail. */
export class CredentialEncryptionError extends Error {
  readonly reasonCode: string;

  constructor(reasonCode: string) {
    super(`Credential encryption failed: ${reasonCode}`);
    this.name = "CredentialEncryptionError";
    this.reasonCode = reasonCode;
  }
}

function assertMasterKey(masterKey: Buffer): void {
  if (masterKey.length !== KEY_BYTES) {
    throw new CredentialEncryptionError("MASTER_KEY_LENGTH_INVALID");
  }
}

function additionalData(context: CredentialEncryptionContext): Buffer {
  // Length-prefixed so distinct field values cannot produce the same binding.
  const parts = [context.workspaceId, context.integrationType, context.accountId];
  return Buffer.from(parts.map((part) => `${part.length}:${part}`).join("|"), "utf8");
}

export function encryptCredential(input: {
  context: CredentialEncryptionContext;
  keyVersion: number;
  masterKey: Buffer;
  plaintext: string;
}): SealedCredential {
  const { context, keyVersion, masterKey, plaintext } = input;
  assertMasterKey(masterKey);

  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new CredentialEncryptionError("KEY_VERSION_INVALID");
  }
  if (plaintext.length === 0) {
    throw new CredentialEncryptionError("PLAINTEXT_EMPTY");
  }

  const aad = additionalData(context);
  const dataKey = randomBytes(KEY_BYTES);

  try {
    const payloadIv = randomBytes(IV_BYTES);
    const payloadCipher = createCipheriv(ALGORITHM, dataKey, payloadIv);
    payloadCipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      payloadCipher.update(plaintext, "utf8"),
      payloadCipher.final(),
    ]);
    const payloadTag = payloadCipher.getAuthTag();

    const wrapIv = randomBytes(IV_BYTES);
    const wrapCipher = createCipheriv(ALGORITHM, masterKey, wrapIv);
    wrapCipher.setAAD(aad);
    const wrappedKey = Buffer.concat([wrapCipher.update(dataKey), wrapCipher.final()]);
    const wrapTag = wrapCipher.getAuthTag();

    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt8(FORMAT_VERSION, 0);
    header.writeUInt32BE(keyVersion, 1);

    const sealed = Buffer.concat([
      header,
      wrapIv,
      wrappedKey,
      wrapTag,
      payloadIv,
      payloadTag,
      ciphertext,
    ]);

    return Object.freeze({ ciphertext: sealed.toString("base64"), keyVersion });
  } finally {
    // Do not leave the data key recoverable from this buffer.
    dataKey.fill(0);
  }
}

export function decryptCredential(input: {
  context: CredentialEncryptionContext;
  masterKeys: ReadonlyMap<number, Buffer>;
  sealed: string;
}): string {
  const { context, masterKeys, sealed } = input;

  let envelope: Buffer;
  try {
    envelope = Buffer.from(sealed, "base64");
  } catch {
    throw new CredentialEncryptionError("ENVELOPE_MALFORMED");
  }

  if (envelope.length <= CIPHERTEXT_OFFSET) {
    throw new CredentialEncryptionError("ENVELOPE_MALFORMED");
  }
  if (envelope.readUInt8(0) !== FORMAT_VERSION) {
    throw new CredentialEncryptionError("ENVELOPE_VERSION_UNSUPPORTED");
  }

  const keyVersion = envelope.readUInt32BE(1);
  const masterKey = masterKeys.get(keyVersion);
  if (!masterKey) {
    throw new CredentialEncryptionError("KEY_VERSION_UNAVAILABLE");
  }
  assertMasterKey(masterKey);

  const aad = additionalData(context);
  const wrapIv = envelope.subarray(HEADER_BYTES, WRAPPED_OFFSET);
  const wrappedKey = envelope.subarray(WRAPPED_OFFSET, WRAPPED_TAG_OFFSET);
  const wrapTag = envelope.subarray(WRAPPED_TAG_OFFSET, PAYLOAD_IV_OFFSET);
  const payloadIv = envelope.subarray(PAYLOAD_IV_OFFSET, PAYLOAD_TAG_OFFSET);
  const payloadTag = envelope.subarray(PAYLOAD_TAG_OFFSET, CIPHERTEXT_OFFSET);
  const ciphertext = envelope.subarray(CIPHERTEXT_OFFSET);

  let dataKey: Buffer | null = null;
  try {
    const unwrap = createDecipheriv(ALGORITHM, masterKey, wrapIv);
    unwrap.setAAD(aad);
    unwrap.setAuthTag(wrapTag);
    dataKey = Buffer.concat([unwrap.update(wrappedKey), unwrap.final()]);

    if (dataKey.length !== KEY_BYTES) {
      throw new CredentialEncryptionError("DATA_KEY_LENGTH_INVALID");
    }

    const payload = createDecipheriv(ALGORITHM, dataKey, payloadIv);
    payload.setAAD(aad);
    payload.setAuthTag(payloadTag);
    return Buffer.concat([payload.update(ciphertext), payload.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof CredentialEncryptionError) throw error;
    // Authentication failures and context mismatches are indistinguishable.
    throw new CredentialEncryptionError("AUTHENTICATION_FAILED");
  } finally {
    dataKey?.fill(0);
  }
}

/** Non-secret metadata: lets scope downgrades be detected without a plaintext compare. */
export function hashGrantedScopes(scopes: readonly string[]): string {
  const normalised = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
  return createHash("sha256").update(normalised.join(","), "utf8").digest("hex");
}

export function scopeHashesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function decodeMasterKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  assertMasterKey(key);
  return key;
}
