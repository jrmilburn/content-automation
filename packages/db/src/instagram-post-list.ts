import { instagramMediaKinds, type InstagramMediaKind } from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { isUuidV7 } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * The triage read path for imported posts.
 *
 * This is a separate projection from `instagramPostSafeSelect` rather than a
 * change to it. That select deliberately omits `caption` so provider text
 * cannot reach a response or a log through an ordinary read; the triage list is
 * the one screen whose stated purpose is to show it to an authorised
 * same-workspace user, so it opts in explicitly and by name. `rawPayload` stays
 * absent from both.
 *
 * Dates cross the boundary as ISO strings, matching the job diagnostics list,
 * so a caller cannot accidentally depend on a `Date` surviving serialisation.
 */

/** One page. Bounded server-side; a caller cannot request more. */
export const instagramPostPageSize = 24;

/** Longest accepted free-text search, applied before the query is built. */
export const instagramPostSearchLimit = 120;

export type InstagramPostListFilters = Readonly<{
  instagramAccountId?: string;
  /** Set when a supplied filter value was invalid, so the result is empty. */
  matchesNothing?: boolean;
  mediaKind?: InstagramMediaKind;
  publishedFrom?: Date;
  publishedTo?: Date;
  search?: string;
}>;

/**
 * Where a post stands on having an analysable source video.
 *
 * `NONE` and `REJECTED` are kept apart because they mean different work: one
 * post has never been given a video, the other was given one that failed
 * validation and needs a different file.
 */
export const sourceVideoStates = ["NONE", "PENDING_VALIDATION", "READY", "REJECTED"] as const;

export type SourceVideoState = (typeof sourceVideoStates)[number];

export type InstagramPostListItem = Readonly<{
  caption: string | null;
  id: string;
  instagramAccountId: string;
  lastImportedAt: string;
  mediaKind: InstagramMediaKind;
  mediaProductType: string | null;
  mediaType: string;
  permalink: string | null;
  providerThumbnailUrl: string | null;
  publishedAt: string;
  sourceVideoState: SourceVideoState;
}>;

export type InstagramPostList = Readonly<{
  generatedAt: string;
  /** Opaque cursor for the next page, or null when this is the last page. */
  nextCursor: string | null;
  posts: readonly InstagramPostListItem[];
  totalCount: number;
}>;

const listSelect = {
  caption: true,
  id: true,
  instagramAccountId: true,
  lastImportedAt: true,
  mediaKind: true,
  mediaProductType: true,
  mediaType: true,
  permalink: true,
  providerThumbnailUrl: true,
  publishedAt: true,
  // Prisma resolves this as one extra query for the whole page rather than one
  // per row, so the list stays free of an N+1. Only the state is read: no
  // object key, checksum or byte count belongs on a triage screen.
  videoAssets: { select: { state: true } },
} as const;

/**
 * Collapses a post's asset versions into the one state worth triaging.
 *
 * A post accumulates versions — a rejected upload, then a replacement — so the
 * most advanced state wins rather than the most recent row. Showing "rejected"
 * for a post that already has a ready replacement would send someone to fix
 * something that is no longer broken.
 */
function resolveSourceVideoState(assets: readonly Readonly<{ state: string }>[]): SourceVideoState {
  if (assets.some((asset) => asset.state === "READY")) return "READY";
  if (assets.some((asset) => asset.state === "PENDING_VALIDATION")) return "PENDING_VALIDATION";
  if (assets.some((asset) => asset.state === "REJECTED")) return "REJECTED";

  return "NONE";
}

const mediaKinds = new Set<string>(instagramMediaKinds);

export function isInstagramMediaKind(value: string): value is InstagramMediaKind {
  return mediaKinds.has(value);
}

/**
 * Lists imported posts newest first, scoped to the workspace.
 *
 * Pagination is keyset rather than offset: a page is anchored to the last row
 * it returned, so an import that adds newer posts while an operator is paging
 * cannot shift rows across page boundaries and make one silently disappear.
 * The `(publishedAt desc, id desc)` ordering is total — `publishedAt` alone is
 * not unique — which is what makes the anchor unambiguous.
 */
export async function loadInstagramPostList(
  database: PrismaClient,
  context: WorkspaceContext,
  filters: InstagramPostListFilters = {},
  cursor: string | null = null,
  now: Date = new Date(),
): Promise<InstagramPostList> {
  if (filters.matchesNothing) return emptyList(now);

  const where = createPostWhere(context.workspaceId, filters);
  // An unreadable cursor is treated as the first page rather than an error: it
  // is a URL a user can edit, not a protocol.
  const anchor = parseCursor(cursor);
  // Built as one typed value rather than an inline conditional spread, because
  // `exactOptionalPropertyTypes` rejects an explicit `cursor: undefined`.
  const paging: Pick<Prisma.InstagramPostFindManyArgs, "cursor" | "skip"> = anchor
    ? // The anchor row itself was returned by the previous page.
      { cursor: { id: anchor }, skip: 1 }
    : {};

  const [totalCount, records] = await database.$transaction([
    database.instagramPost.count({ where }),
    database.instagramPost.findMany({
      ...paging,
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      select: listSelect,
      take: instagramPostPageSize + 1,
      where,
    }),
  ]);

  // One extra row is read purely to learn whether another page exists, without
  // a second count that could disagree with this one.
  const hasMore = records.length > instagramPostPageSize;
  const page = hasMore ? records.slice(0, instagramPostPageSize) : records;

  return Object.freeze({
    generatedAt: now.toISOString(),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    posts: Object.freeze(page.map(toListItem)),
    totalCount,
  });
}

function toListItem(record: {
  caption: string | null;
  id: string;
  instagramAccountId: string;
  lastImportedAt: Date;
  mediaKind: string;
  mediaProductType: string | null;
  mediaType: string;
  permalink: string | null;
  providerThumbnailUrl: string | null;
  publishedAt: Date;
  videoAssets: readonly Readonly<{ state: string }>[];
}): InstagramPostListItem {
  return Object.freeze({
    caption: record.caption,
    id: record.id,
    instagramAccountId: record.instagramAccountId,
    lastImportedAt: record.lastImportedAt.toISOString(),
    mediaKind: record.mediaKind as InstagramMediaKind,
    mediaProductType: record.mediaProductType,
    mediaType: record.mediaType,
    // A non-HTTPS permalink is dropped rather than rendered; normalisation
    // already rejects one, so this is a second gate on stored history.
    permalink: isHttpsUrl(record.permalink) ? record.permalink : null,
    providerThumbnailUrl: isHttpsUrl(record.providerThumbnailUrl)
      ? record.providerThumbnailUrl
      : null,
    publishedAt: record.publishedAt.toISOString(),
    sourceVideoState: resolveSourceVideoState(record.videoAssets),
  });
}

function createPostWhere(workspaceId: string, filters: InstagramPostListFilters) {
  const publishedAt =
    filters.publishedFrom || filters.publishedTo
      ? {
          ...(filters.publishedFrom ? { gte: filters.publishedFrom } : {}),
          ...(filters.publishedTo ? { lte: filters.publishedTo } : {}),
        }
      : undefined;

  return {
    workspaceId,
    ...(filters.instagramAccountId ? { instagramAccountId: filters.instagramAccountId } : {}),
    ...(filters.mediaKind ? { mediaKind: filters.mediaKind } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(filters.search
      ? {
          caption: {
            contains: filters.search.slice(0, instagramPostSearchLimit),
            mode: "insensitive" as const,
          },
        }
      : {}),
  };
}

function parseCursor(cursor: string | null): string | null {
  return cursor && isUuidV7(cursor) ? cursor : null;
}

function isHttpsUrl(value: string | null): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function emptyList(now: Date): InstagramPostList {
  return Object.freeze({
    generatedAt: now.toISOString(),
    nextCursor: null,
    posts: Object.freeze([]),
    totalCount: 0,
  });
}
