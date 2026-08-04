import { createHash, randomBytes } from "node:crypto";

/**
 * Object keys are built by the server and never supplied by a client.
 *
 * The environment prefix keeps production objects out of preview and dev
 * buckets, the workspace prefix keeps ownership legible in the store itself,
 * and the suffix is cryptographically random rather than a UUIDv7 so a key
 * leaks neither creation time nor its neighbours. The original filename is
 * never part of the key.
 */

const sourceVideoSegment = "source-video";
const randomSuffixBytes = 16;

export type SourceVideoKeyParts = Readonly<{
  environment: string;
  workspaceId: string;
}>;

export function createSourceVideoObjectKey(parts: SourceVideoKeyParts): string {
  const suffix = randomBytes(randomSuffixBytes).toString("hex");

  return `${parts.environment}/${parts.workspaceId}/${sourceVideoSegment}/${suffix}`;
}

/**
 * The key one server-side transfer writes to, derived from the work that is
 * doing the writing.
 *
 * A server transfer writes the object before any row exists to point at it, so
 * a key minted afresh on each attempt would leave the previous attempt's bytes
 * in the bucket with nothing referencing them and no purge sweep able to find
 * them. Deriving the key means a retry overwrites its own earlier attempt.
 *
 * The seed is hashed rather than used directly: it is a UUIDv7, and putting one
 * in the key would leak creation time and ordering, which is precisely what the
 * random suffix above exists to avoid.
 */
export function createDerivedSourceVideoObjectKey(
  parts: SourceVideoKeyParts & Readonly<{ seed: string }>,
): string {
  const suffix = createHash("sha256")
    .update(`source-video:${parts.workspaceId}:${parts.seed}`, "utf8")
    .digest("hex")
    .slice(0, randomSuffixBytes * 2);

  return `${parts.environment}/${parts.workspaceId}/${sourceVideoSegment}/${suffix}`;
}

/**
 * Confirms a stored key still matches the environment and workspace it is being
 * used for. This guards against a crafted or mis-joined record reaching a
 * signing call, not against a client submitting a key: no command accepts one.
 */
export function isSourceVideoObjectKeyFor(objectKey: string, parts: SourceVideoKeyParts): boolean {
  const segments = objectKey.split("/");

  if (segments.length !== 4) {
    return false;
  }

  const [environment, workspaceId, segment, suffix] = segments;

  return (
    environment === parts.environment &&
    workspaceId === parts.workspaceId &&
    segment === sourceVideoSegment &&
    suffix !== undefined &&
    new RegExp(`^[0-9a-f]{${randomSuffixBytes * 2}}$`, "u").test(suffix)
  );
}
