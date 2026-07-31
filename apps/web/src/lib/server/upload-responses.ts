import "server-only";

import type { UploadRefusalReason } from "./video-upload";

/**
 * Maps a refusal to a status code without leaking existence.
 *
 * Every "not found" case answers 404 whether the resource is absent, belongs to
 * another workspace or was never a valid identifier, so a caller cannot use
 * status codes to enumerate posts or intents. Refusals that describe the
 * caller's own request answer 4xx; a provider outage answers 502 because the
 * request was legitimate and may succeed on retry.
 */

const refusalStatuses: Readonly<Record<UploadRefusalReason, number>> = Object.freeze({
  CONTENT_TYPE_NOT_ACCEPTED: 415,
  DUPLICATE_PART: 400,
  EMPTY_FILE: 400,
  INTENT_NOT_FOUND: 404,
  INTENT_NOT_PENDING: 409,
  OBJECT_MISSING: 409,
  PART_NUMBER_OUT_OF_RANGE: 400,
  POST_NOT_FOUND: 404,
  SIZE_MISMATCH: 422,
  STORAGE_UNAVAILABLE: 502,
  TOO_LARGE: 413,
  UPLOAD_ALREADY_PENDING: 409,
  UPLOAD_EXPIRED: 410,
});

const noStoreHeaders = Object.freeze({
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/**
 * Signed URLs are sensitive and must never be cached by a shared cache or
 * recorded by a referrer, so every upload response carries the same headers.
 */
export function uploadJson(body: unknown, status: number): Response {
  return Response.json(body, { headers: noStoreHeaders, status });
}

export function uploadRefusal(reason: UploadRefusalReason, correlationId: string): Response {
  return uploadJson({ reason, reference: correlationId }, refusalStatuses[reason]);
}
