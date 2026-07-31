import { randomBytes } from "node:crypto";

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
