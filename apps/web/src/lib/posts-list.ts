import type {
  InstagramPostListFilters,
  InstagramPostListItem,
  SourceVideoState,
} from "@studio-parallel/db";
import { instagramMediaKinds, type InstagramMediaKind } from "@studio-parallel/domain";

import type { StatusTone } from "../components/status-badge";

/**
 * Pure parsing and presentation for the imported posts list.
 *
 * An unrecognised filter value sets `matchesNothing` rather than being dropped.
 * Dropping it would silently widen the result to everything, which reads as
 * "these are your matches" when it is really "your filter was ignored".
 */

export type PostsSearchParams = Record<string, string | string[] | undefined>;

export type PostsFilterValues = Readonly<{
  account: string;
  from: string;
  kind: "all" | InstagramMediaKind;
  search: string;
  to: string;
}>;

export const mediaKindLabels: Readonly<Record<InstagramMediaKind, string>> = Object.freeze({
  CAROUSEL_ALBUM: "Carousel",
  IMAGE: "Image",
  REEL: "Reel",
  UNSUPPORTED: "Unsupported media",
  VIDEO: "Video",
});

export const mediaKindFilterOptions: ReadonlyArray<
  Readonly<{ label: string; value: InstagramMediaKind }>
> = instagramMediaKinds.map((value) => ({ label: mediaKindLabels[value], value }));

/**
 * The triage dimensions this product will eventually filter on, none of which
 * have any stored data yet. They are named rather than hidden so the screen
 * says what it cannot tell you instead of implying every post is fine.
 */
export const pendingTriageDimensions = [
  Object.freeze({
    detail: "Analysis has not run against any post yet.",
    label: "Analysis",
  }),
  Object.freeze({
    detail: "Performance metrics are not captured yet, so none can be compared.",
    label: "Metrics",
  }),
] as const;

export function parsePostsFilters(searchParams: PostsSearchParams): Readonly<{
  cursor: string | null;
  filters: InstagramPostListFilters;
  values: PostsFilterValues;
}> {
  const rawKind = firstValue(searchParams.kind);
  const rawAccount = firstValue(searchParams.account);
  const rawFrom = firstValue(searchParams.from);
  const rawTo = firstValue(searchParams.to);
  const search = firstValue(searchParams.q).trim().slice(0, 120);
  let matchesNothing = false;

  const mediaKind = isMediaKind(rawKind) ? rawKind : undefined;
  if (rawKind && rawKind !== "all" && !mediaKind) matchesNothing = true;

  const instagramAccountId = isUuidV7(rawAccount) ? rawAccount : undefined;
  if (rawAccount && rawAccount !== "all" && !instagramAccountId) matchesNothing = true;

  const publishedFrom = parseDate(rawFrom);
  if (rawFrom && !publishedFrom) matchesNothing = true;

  // The end of the chosen day, so "to 2026-07-31" includes that day's posts
  // rather than only ones published exactly at midnight.
  const publishedTo = parseDate(rawTo, true);
  if (rawTo && !publishedTo) matchesNothing = true;

  if (publishedFrom && publishedTo && publishedFrom > publishedTo) matchesNothing = true;

  return Object.freeze({
    cursor: firstValue(searchParams.after) || null,
    filters: Object.freeze({
      ...(instagramAccountId ? { instagramAccountId } : {}),
      ...(matchesNothing ? { matchesNothing: true } : {}),
      ...(mediaKind ? { mediaKind } : {}),
      ...(publishedFrom ? { publishedFrom } : {}),
      ...(publishedTo ? { publishedTo } : {}),
      ...(search ? { search } : {}),
    }),
    values: Object.freeze({
      account: instagramAccountId ?? (rawAccount === "all" ? "" : rawAccount),
      from: rawFrom,
      kind: mediaKind ?? "all",
      search,
      to: rawTo,
    }),
  });
}

export function hasActiveFilters(values: PostsFilterValues): boolean {
  return (
    values.account !== "" ||
    values.from !== "" ||
    values.kind !== "all" ||
    values.search !== "" ||
    values.to !== ""
  );
}

/** Rebuilds the current query string, replacing only the page anchor. */
export function buildPostsHref(values: PostsFilterValues, cursor: string | null): string {
  const params = new URLSearchParams();
  if (values.search) params.set("q", values.search);
  if (values.kind !== "all") params.set("kind", values.kind);
  if (values.account) params.set("account", values.account);
  if (values.from) params.set("from", values.from);
  if (values.to) params.set("to", values.to);
  if (cursor) params.set("after", cursor);

  const query = params.toString();
  return query ? `/posts?${query}` : "/posts";
}

export function presentMediaKind(
  post: Readonly<{ mediaKind: InstagramMediaKind; mediaProductType: string | null }>,
): Readonly<{ label: string; tone: StatusTone }> {
  if (post.mediaKind === "REEL") return { label: "Reel", tone: "information" };
  if (post.mediaKind === "UNSUPPORTED") {
    // Retained deliberately at import so an unrecognised type stays inspectable
    // rather than being dropped; it is a real triage bucket.
    return { label: "Unsupported media", tone: "warning" };
  }
  return { label: mediaKindLabels[post.mediaKind], tone: "neutral" };
}

export function captionExcerpt(caption: string | null, limit = 160): string {
  if (!caption) return "No caption";
  const collapsed = caption.replace(/\s+/gu, " ").trim();
  if (!collapsed) return "No caption";
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1).trimEnd()}…`;
}

export function formatPublishedAt(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(new Date(value));
}

export function postAccessibleName(post: InstagramPostListItem): string {
  return `${presentMediaKind(post).label} published ${formatPublishedAt(post.publishedAt)}`;
}

/**
 * How each source-video state reads on a triage card.
 *
 * The action text differs per state because the work differs: an untouched post
 * needs a first upload, a rejected one needs a different file, and a ready one
 * only needs replacing if the operator chooses to.
 */
const sourceVideoPresentation: Readonly<
  Record<SourceVideoState, Readonly<{ action: string; label: string; tone: StatusTone }>>
> = Object.freeze({
  NONE: Object.freeze({ action: "Add source video", label: "No source video", tone: "neutral" }),
  PENDING_VALIDATION: Object.freeze({
    action: "View source video",
    label: "Checking source video",
    tone: "information",
  }),
  READY: Object.freeze({
    action: "Replace source video",
    label: "Source video ready",
    tone: "success",
  }),
  REJECTED: Object.freeze({
    action: "Upload a different file",
    label: "Source video rejected",
    tone: "warning",
  }),
});

export function presentSourceVideo(
  post: Readonly<{ sourceVideoState: SourceVideoState }>,
): Readonly<{ action: string; label: string; tone: StatusTone }> {
  return sourceVideoPresentation[post.sourceVideoState];
}

/** The in-application route to one post's source video. */
export function sourceVideoHref(postId: string): string {
  return `/posts/${postId}/source-video`;
}

function parseDate(value: string, endOfDay = false): Date | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function isMediaKind(value: string): value is InstagramMediaKind {
  return (instagramMediaKinds as readonly string[]).includes(value);
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
