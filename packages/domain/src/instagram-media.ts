import { createHash } from "node:crypto";

/**
 * Pure Instagram owned-media contract: the requested field set, Reel
 * classification, item normalisation, provenance hashing, cursor reading and
 * safe response classification.
 *
 * This module is the single source of truth for how a provider media item
 * becomes a normalised post. It performs no network, storage or logging work so
 * every rule can be tested exhaustively, and so the worker adapter is left with
 * nothing but HTTP plumbing.
 *
 * Nothing here returns provider text in an error: failures reduce to a reason
 * code, because a rejected item is counted and isolated rather than logged.
 */

/**
 * Only fields Meta documents for the owned-media edge at the pinned version are
 * requested. `media_url` and `thumbnail_url` are display-only signed URLs; see
 * `instagramEphemeralUrlFields`.
 */
export const instagramMediaFields = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "permalink",
  "timestamp",
  "thumbnail_url",
  "media_url",
  "username",
] as const;

/**
 * Instagram CDN URLs are signed and rotate on every request. They are display
 * and import metadata only: they are never a durable source asset, and they are
 * excluded from the provenance hash so that re-reading unchanged media does not
 * look like a change.
 */
export const instagramEphemeralUrlFields = ["media_url", "thumbnail_url"] as const;

/** Provider page size. Meta caps the media edge well below this in practice. */
export const instagramMediaPageSize = 50;

/** Hard bound so a pathological or looping cursor cannot run forever. */
export const instagramMaximumSyncPages = 200;

/** Default bootstrap horizon from `docs/technical/instagram-integration.md`. */
export const instagramBootstrapHorizonDays = 180;

export const instagramMediaKinds = [
  "REEL",
  "VIDEO",
  "IMAGE",
  "CAROUSEL_ALBUM",
  "UNSUPPORTED",
] as const;

export type InstagramMediaKind = (typeof instagramMediaKinds)[number];

/** A published Reel reports `media_type=VIDEO`; only this value identifies it. */
export const instagramReelProductType = "REELS";

export const instagramSyncTriggers = ["BOOTSTRAP", "MANUAL", "SCHEDULED", "RECONCILE"] as const;

export type InstagramSyncTrigger = (typeof instagramSyncTriggers)[number];

export const instagramMediaRejectionReasons = [
  "ITEM_NOT_OBJECT",
  "ITEM_NOT_SERIALISABLE",
  "ITEM_TOO_LARGE",
  "MEDIA_ID_INVALID",
  "MEDIA_TYPE_INVALID",
  "TIMESTAMP_INVALID",
] as const;

export type InstagramMediaRejectionReason = (typeof instagramMediaRejectionReasons)[number];

export const instagramResponseClasses = [
  "authorisation",
  "invalid_request",
  "rate_limit",
  "transient",
  "unsupported",
] as const;

export type InstagramResponseClass = (typeof instagramResponseClasses)[number];

export type NormalisedInstagramMedia = Readonly<{
  caption: string | null;
  /** Signed, short-lived provider URL. Display only; never a source asset. */
  ephemeralMediaUrl: string | null;
  /** Signed, short-lived provider URL. Display only; never a source asset. */
  ephemeralThumbnailUrl: string | null;
  kind: InstagramMediaKind;
  mediaProductType: string | null;
  mediaType: string;
  permalink: string | null;
  providerMediaId: string;
  publishedAt: Date;
  rawPayload: Readonly<Record<string, unknown>>;
  rawPayloadHash: string;
  username: string | null;
}>;

export type InstagramMediaNormalisation =
  | Readonly<{ media: NormalisedInstagramMedia; ok: true }>
  | Readonly<{ ok: false; reason: InstagramMediaRejectionReason }>;

export type InstagramMediaPage = Readonly<{
  after: string | null;
  hasNextPage: boolean;
  items: readonly unknown[];
}>;

export type InstagramUsageObservation = Readonly<{
  header: string;
  maximumPercentage: number | null;
}>;

/** Safe aggregate usage headers. Values are percentages, never identifiers. */
export const instagramUsageHeaders = ["x-app-usage", "x-business-use-case-usage"] as const;

const providerMediaIdPattern = /^[0-9]{5,32}$/u;
const providerEnumPattern = /^[A-Z][A-Z0-9_]{0,31}$/u;
const providerCursorPattern = /^[A-Za-z0-9_-]{1,512}$/u;
const maximumRawPayloadBytes = 65_536;
const earliestPlausiblePublishedAt = Date.UTC(2010, 0, 1);
const latestPlausiblePublishedAt = Date.UTC(2100, 0, 1);
const ephemeralUrlFields = new Set<string>(instagramEphemeralUrlFields);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Accepts only absolute HTTPS URLs, so a provider value cannot become a
 * `javascript:` or plaintext link when rendered later. */
function readHttpsUrl(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = readString(record, key);
  if (!value) return null;

  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function reject(reason: InstagramMediaRejectionReason): InstagramMediaNormalisation {
  return Object.freeze({ ok: false as const, reason });
}

/**
 * Meta returns `2026-07-01T04:12:33+0000`. The compact offset is not valid
 * ISO 8601 and is parsed inconsistently, so it is expanded before parsing
 * rather than trusted to the engine.
 */
export function parseInstagramTimestamp(value: string | null): Date | null {
  if (!value) return null;

  const expanded = value.replace(/([+-])(\d{2})(\d{2})$/u, "$1$2:$3");
  const parsed = Date.parse(expanded);

  if (!Number.isFinite(parsed)) return null;
  if (parsed < earliestPlausiblePublishedAt || parsed >= latestPlausiblePublishedAt) return null;

  return new Date(parsed);
}

/**
 * `media_product_type` is authoritative for Reels because a published Reel
 * reports `media_type=VIDEO`. An unrecognised product type is not discarded:
 * the item falls back to its media type and both provider values are retained
 * on the row, so unsupported media stays inspectable.
 */
export function classifyInstagramMedia(
  input: Readonly<{ mediaProductType: string | null; mediaType: string }>,
): InstagramMediaKind {
  if (input.mediaProductType === instagramReelProductType) return "REEL";

  switch (input.mediaType) {
    case "CAROUSEL_ALBUM":
      return "CAROUSEL_ALBUM";
    case "IMAGE":
      return "IMAGE";
    case "VIDEO":
      return "VIDEO";
    default:
      return "UNSUPPORTED";
  }
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (ephemeralUrlFields.has(key)) continue;
    result[key] = canonicalise(value[key]);
  }
  return result;
}

/**
 * Stable provenance hash for one media item.
 *
 * Keys are ordered so that provider field ordering cannot change the digest,
 * and the signed CDN URLs are removed first because they are regenerated on
 * every request — including them would report unchanged media as modified on
 * every sync.
 */
export function hashInstagramMediaPayload(item: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalise(item)) ?? "", "utf8")
    .digest("hex");
}

/**
 * Converts one provider item into a normalised post, or reports why it cannot
 * be trusted. A rejection is an isolated, counted outcome: the caller keeps the
 * rest of the page rather than failing the run.
 */
export function normaliseInstagramMediaItem(item: unknown): InstagramMediaNormalisation {
  if (!isRecord(item)) return reject("ITEM_NOT_OBJECT");

  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(item);
  } catch {
    return reject("ITEM_NOT_SERIALISABLE");
  }
  if (typeof serialised !== "string") return reject("ITEM_NOT_SERIALISABLE");
  if (serialised.length > maximumRawPayloadBytes) return reject("ITEM_TOO_LARGE");

  const providerMediaId = readString(item, "id");
  if (!providerMediaId || !providerMediaIdPattern.test(providerMediaId)) {
    return reject("MEDIA_ID_INVALID");
  }

  const mediaType = readString(item, "media_type");
  if (!mediaType || !providerEnumPattern.test(mediaType)) return reject("MEDIA_TYPE_INVALID");

  const publishedAt = parseInstagramTimestamp(readString(item, "timestamp"));
  if (!publishedAt) return reject("TIMESTAMP_INVALID");

  const rawProductType = readString(item, "media_product_type");
  const mediaProductType =
    rawProductType && providerEnumPattern.test(rawProductType) ? rawProductType : null;
  const caption = item.caption;

  return Object.freeze({
    media: Object.freeze({
      caption: typeof caption === "string" ? caption : null,
      ephemeralMediaUrl: readHttpsUrl(item, "media_url"),
      ephemeralThumbnailUrl: readHttpsUrl(item, "thumbnail_url"),
      kind: classifyInstagramMedia({ mediaProductType, mediaType }),
      mediaProductType,
      mediaType,
      permalink: readHttpsUrl(item, "permalink"),
      providerMediaId,
      publishedAt,
      rawPayload: Object.freeze({ ...item }),
      rawPayloadHash: hashInstagramMediaPayload(item),
      username: readString(item, "username"),
    }),
    ok: true as const,
  });
}

/**
 * Reads one media page. A cursor is accepted only in the opaque token shape
 * Meta issues, so a hostile `next` value cannot be reflected into a later
 * request URL.
 */
export function readInstagramMediaPage(body: unknown): InstagramMediaPage {
  if (!isRecord(body)) return Object.freeze({ after: null, hasNextPage: false, items: [] });

  const items = Array.isArray(body.data) ? Object.freeze([...body.data]) : Object.freeze([]);
  const paging = isRecord(body.paging) ? body.paging : null;
  const cursors = paging && isRecord(paging.cursors) ? paging.cursors : null;
  const after = cursors ? readString(cursors, "after") : null;

  return Object.freeze({
    after: after && providerCursorPattern.test(after) ? after : null,
    hasNextPage: Boolean(paging && typeof paging.next === "string"),
    items,
  });
}

/**
 * Maps a provider response to a retry class. `unsupported` and
 * `invalid_request` are permanent: retrying them burns quota without changing
 * the outcome.
 */
export function classifyInstagramResponse(
  input: Readonly<{ body: unknown; status: number }>,
): InstagramResponseClass {
  if (input.status === 429) return "rate_limit";
  if (input.status === 401 || input.status === 403) return "authorisation";
  if (input.status >= 500) return "transient";

  const error = isRecord(input.body) && isRecord(input.body.error) ? input.body.error : null;
  const code = error && typeof error.code === "number" ? error.code : null;
  const subcode = error && typeof error.error_subcode === "number" ? error.error_subcode : null;

  // Meta reports an expired or revoked token as a 400 with code 190 rather than
  // a 401, so status alone would misclassify a reconnect as a bad request.
  if (code === 190) return "authorisation";
  if (code === 4 || code === 17 || code === 32 || code === 613) return "rate_limit";
  if (input.status === 400 && (code === 100 || subcode === 2108006)) return "unsupported";

  return "invalid_request";
}

function collectNumbers(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectNumbers);
  if (isRecord(value)) return Object.values(value).flatMap(collectNumbers);
  return [];
}

/**
 * Reduces the provider usage headers to a maximum percentage per header.
 *
 * The lookup is injected rather than taking a `Headers` object so this module
 * stays free of platform types, and only the numeric peak is kept so no
 * business-use-case identifier is retained.
 */
export function summariseInstagramUsage(
  readHeader: (header: string) => string | null | undefined,
): readonly InstagramUsageObservation[] {
  return Object.freeze(
    instagramUsageHeaders.flatMap((header) => {
      const value = readHeader(header);
      if (!value) return [];

      let maximumPercentage: number | null;
      try {
        const values = collectNumbers(JSON.parse(value));
        maximumPercentage = values.length > 0 ? Math.max(...values) : null;
      } catch {
        maximumPercentage = null;
      }

      return [Object.freeze({ header, maximumPercentage })];
    }),
  );
}

/** `Retry-After` is documented in seconds; an HTTP-date form is ignored. */
export function parseInstagramRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;

  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  return Math.min(Math.floor(seconds), 86_400) * 1_000;
}
