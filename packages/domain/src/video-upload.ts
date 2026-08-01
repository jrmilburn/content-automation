import { z } from "zod";

/**
 * Upload admission policy for source video.
 *
 * Configuration owns the byte ceiling; this module owns everything that is a
 * product decision rather than a deployment one. The accepted set is
 * deliberately narrower than what Gemini can decode, because every format here
 * must also survive the browser upload path and the operations-tested probe.
 * See `docs/technical/video-ingestion.md`.
 *
 * Nothing decided here is a security control on its own: a declared content
 * type is a claim by the browser, so admission only decides whether an upload
 * is worth starting. The container is proven by magic bytes during validation.
 */

// MP4, QuickTime/MOV and WebM only. AVI, FLV, WMV and 3GPP are decodable by the
// provider but are not offered, so a user is refused before a long upload
// rather than after one.
export const acceptedVideoContentTypes = ["video/mp4", "video/quicktime", "video/webm"] as const;

export type AcceptedVideoContentType = (typeof acceptedVideoContentTypes)[number];

export const acceptedVideoFileExtensions = [".mp4", ".mov", ".webm"] as const;

export function isAcceptedVideoContentType(value: string): value is AcceptedVideoContentType {
  return (acceptedVideoContentTypes as readonly string[]).includes(value);
}

export const uploadAdmissionRefusalReasons = [
  "CONTENT_TYPE_NOT_ACCEPTED",
  "EMPTY_FILE",
  "TOO_LARGE",
] as const;

export type UploadAdmissionRefusalReason = (typeof uploadAdmissionRefusalReasons)[number];

export type UploadAdmissionDecision =
  | Readonly<{ admitted: true; partCount: number; partSizeBytes: number }>
  | Readonly<{ admitted: false; reason: UploadAdmissionRefusalReason }>;

export type UploadAdmissionRequest = Readonly<{
  declaredBytes: number;
  declaredContentType: string;
  maxBytes: number;
  partSizeBytes: number;
}>;

/**
 * Decides whether to reserve an upload, and how many parts it will take.
 *
 * A zero-byte file is refused here rather than at validation because there is
 * nothing to upload and a multipart upload with no parts cannot be completed.
 */
export function evaluateUploadAdmission(request: UploadAdmissionRequest): UploadAdmissionDecision {
  if (!Number.isSafeInteger(request.declaredBytes) || request.declaredBytes <= 0) {
    return Object.freeze({ admitted: false as const, reason: "EMPTY_FILE" as const });
  }

  if (request.declaredBytes > request.maxBytes) {
    return Object.freeze({ admitted: false as const, reason: "TOO_LARGE" as const });
  }

  if (!isAcceptedVideoContentType(request.declaredContentType)) {
    return Object.freeze({
      admitted: false as const,
      reason: "CONTENT_TYPE_NOT_ACCEPTED" as const,
    });
  }

  return Object.freeze({
    admitted: true as const,
    partCount: Math.ceil(request.declaredBytes / request.partSizeBytes),
    partSizeBytes: request.partSizeBytes,
  });
}

/**
 * What the browser may send when completing an upload.
 *
 * Part numbers and ETags come from the provider's own responses, so they are
 * shape-checked rather than trusted: the provider rejects a completion whose
 * parts it did not store, and the server re-reads the object afterwards.
 */
export const completeUploadRequestSchema = z.object({
  checksumSha256: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/u, "must be a lowercase hex sha256")
    .optional(),
  parts: z
    .array(
      z.object({
        etag: z.string().trim().min(1).max(256),
        partNumber: z.int().min(1).max(10_000),
      }),
    )
    .min(1)
    .max(10_000),
});

export type CompleteUploadRequest = Readonly<z.infer<typeof completeUploadRequestSchema>>;

/**
 * Rejects duplicate part numbers before they reach the provider.
 *
 * A resumed upload that re-sends a part must supersede it, not list it twice:
 * a duplicated part number would make the completed object's length depend on
 * which copy the provider picked.
 */
export function hasUniquePartNumbers(parts: CompleteUploadRequest["parts"]): boolean {
  return new Set(parts.map((part) => part.partNumber)).size === parts.length;
}

/**
 * Validation is keyed by the asset, not by the request that produced it.
 *
 * A replayed completion resolves to the same asset, so it produces the same key
 * and the queue deduplicates it. Nothing time-based appears in the key: a
 * retry that lands minutes later must still be recognised as the same work.
 */
export function videoAssetValidationKey(assetId: string): string {
  return `asset-validate-${assetId}`;
}

/**
 * Cleanup is keyed by the intent and the UTC day the sweep ran.
 *
 * The day bucket lets a later sweep retry an abandonment that failed to reach
 * the provider, while a sweep repeated within the same day costs nothing.
 */
export function videoUploadCleanupKey(intentId: string, at: Date): string {
  return `asset-cleanup-${intentId}-${at.toISOString().slice(0, 10)}`;
}

/**
 * Purging a rejected asset's stored object is keyed the same way, and by the
 * asset rather than the intent so the two sweeps can never collide on one key.
 */
export function videoAssetPurgeKey(assetId: string, at: Date): string {
  return `asset-purge-${assetId}-${at.toISOString().slice(0, 10)}`;
}
