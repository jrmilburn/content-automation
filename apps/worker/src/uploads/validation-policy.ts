import type { MediaValidationConfig } from "@studio-parallel/config";

import type { ProbedMedia } from "./media-probe.js";
import type { ContainerFamily } from "./object-staging.js";

/**
 * The validation verdict, as a pure function of observed evidence.
 *
 * Keeping the decision separate from the handler is what makes the policy
 * testable without a database, a queue or a real media file: every rejection
 * branch in docs/technical/video-ingestion.md is reachable from a plain object.
 */

export type RejectionCode =
  | "EMPTY_OBJECT"
  | "BYTES_EXCEEDED"
  | "CHECKSUM_MISMATCH"
  | "CONTAINER_UNSUPPORTED"
  | "CONTAINER_MISMATCH"
  | "UNDECODABLE"
  | "NO_VIDEO_STREAM"
  | "VIDEO_CODEC_UNSUPPORTED"
  | "AUDIO_CODEC_UNSUPPORTED"
  | "DURATION_OUT_OF_RANGE"
  | "DIMENSIONS_OUT_OF_RANGE";

export type ValidationVerdict =
  | Readonly<{ accepted: true; media: ProbedMedia }>
  | Readonly<{ accepted: false; code: RejectionCode }>;

/**
 * Which container family a declared content type must resolve to.
 *
 * MP4 and QuickTime share the ISO base media file format, and ffprobe reports
 * the same demuxer list for both. Distinguishing them is therefore not possible
 * from the probe alone, and this product does not need to: it checks that the
 * declared type and the observed bytes belong to the same family, which is what
 * catches a WebM renamed to `.mp4` or a polyglot with a mismatched header.
 */
const declaredContentTypeFamilies: Readonly<Record<string, ContainerFamily>> = Object.freeze({
  "video/mp4": "ISO_BMFF",
  "video/quicktime": "ISO_BMFF",
  "video/webm": "MATROSKA",
});

/** ffprobe demuxer tokens that identify each accepted container family. */
const probeFormatFamilies: Readonly<Record<string, ContainerFamily>> = Object.freeze({
  matroska: "MATROSKA",
  mov: "ISO_BMFF",
  mp4: "ISO_BMFF",
  webm: "MATROSKA",
});

export function resolveDeclaredFamily(declaredContentType: string): ContainerFamily | null {
  return declaredContentTypeFamilies[declaredContentType.trim().toLowerCase()] ?? null;
}

export function resolveProbedFamily(formats: readonly string[]): ContainerFamily | null {
  for (const format of formats) {
    const family = probeFormatFamilies[format];

    if (family !== undefined) {
      return family;
    }
  }

  return null;
}

export type ValidationEvidence = Readonly<{
  declaredContentType: string;
  /** Container family implied by the object's own first bytes. */
  headerFamily: ContainerFamily | null;
  media: ProbedMedia;
}>;

/**
 * Applies the configured policy to evidence gathered from the stored object.
 *
 * Byte-level checks that do not need the probe (empty, oversized, checksum) are
 * handled by the caller before probing, because there is no reason to hand
 * ffprobe bytes that are already known to be unacceptable.
 */
export function evaluateProbedMedia(
  evidence: ValidationEvidence,
  config: MediaValidationConfig,
): ValidationVerdict {
  const declaredFamily = resolveDeclaredFamily(evidence.declaredContentType);

  // The upload API only issues intents for accepted content types, so an
  // unknown one here means the row predates the current policy or was written
  // outside that path. Refuse rather than assume a family.
  if (declaredFamily === null) {
    return Object.freeze({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  }

  // The header is checked independently of ffprobe so a polyglot that satisfies
  // one parser but not the other cannot pass by agreeing with only one of them.
  if (evidence.headerFamily === null) {
    return Object.freeze({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  }

  if (evidence.headerFamily !== declaredFamily) {
    return Object.freeze({ accepted: false, code: "CONTAINER_MISMATCH" });
  }

  const probedFamily = resolveProbedFamily(evidence.media.containerFormats);

  if (probedFamily === null) {
    return Object.freeze({ accepted: false, code: "CONTAINER_UNSUPPORTED" });
  }

  if (probedFamily !== declaredFamily) {
    return Object.freeze({ accepted: false, code: "CONTAINER_MISMATCH" });
  }

  if (!config.MEDIA_ALLOWED_VIDEO_CODECS.includes(evidence.media.videoCodec)) {
    return Object.freeze({ accepted: false, code: "VIDEO_CODEC_UNSUPPORTED" });
  }

  // Audio is optional. When a track is present it must still be an accepted
  // codec, and a track whose codec the probe could not name is not accepted.
  if (
    evidence.media.audioCodec !== null &&
    !config.MEDIA_ALLOWED_AUDIO_CODECS.includes(evidence.media.audioCodec)
  ) {
    return Object.freeze({ accepted: false, code: "AUDIO_CODEC_UNSUPPORTED" });
  }

  const durationSeconds = evidence.media.durationMs / 1000;

  if (
    durationSeconds < config.MEDIA_MIN_DURATION_SECONDS ||
    durationSeconds > config.MEDIA_MAX_DURATION_SECONDS
  ) {
    return Object.freeze({ accepted: false, code: "DURATION_OUT_OF_RANGE" });
  }

  const smallest = Math.min(evidence.media.widthPx, evidence.media.heightPx);
  const largest = Math.max(evidence.media.widthPx, evidence.media.heightPx);

  // Bounds apply to both axes rather than to a fixed orientation, so vertical
  // Reels and horizontal source footage are judged by the same rule.
  if (smallest < config.MEDIA_MIN_DIMENSION_PX || largest > config.MEDIA_MAX_DIMENSION_PX) {
    return Object.freeze({ accepted: false, code: "DIMENSIONS_OUT_OF_RANGE" });
  }

  return Object.freeze({ accepted: true, media: evidence.media });
}
