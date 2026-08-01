import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  listInstagramAccountSummaries,
  loadInstagramPostList,
  type InstagramPostList,
  type InstagramPostListFilters,
} from "@studio-parallel/db";

import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

/**
 * Loads the posts list plus the accounts needed for the account filter.
 *
 * `hasAccount` distinguishes the two empty results that mean different things:
 * no Instagram account is connected yet, versus a connected account whose sync
 * has imported nothing. They need different copy and a different next action.
 */

export type PostsAccountOption = Readonly<{ id: string; label: string }>;

export type PostsSnapshot = Readonly<{
  accounts: readonly PostsAccountOption[];
  hasAccount: boolean;
  list: InstagramPostList;
}>;

export async function loadPostsSnapshot(
  filters: InstagramPostListFilters,
  cursor: string | null,
  now = new Date(),
): Promise<PostsSnapshot> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testSnapshot(filters, cursor, now);

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);

  const [summaries, list] = await Promise.all([
    listInstagramAccountSummaries(database, context, { now }),
    loadInstagramPostList(database, context, filters, cursor, now),
  ]);

  return Object.freeze({
    accounts: Object.freeze(
      summaries.map((summary) =>
        Object.freeze({
          id: summary.accountId,
          label: summary.username ? `@${summary.username}` : "Unnamed account",
        }),
      ),
    ),
    hasAccount: summaries.length > 0,
    list,
  });
}

const testAccountId = "019a0000-0000-7000-8000-000000000301";
// One post per source-video state, so local and browser runs exercise every
// badge and every action label without needing a real upload to have happened.
const testPosts = [
  {
    caption:
      "Three lighting mistakes that flatten a product shot, and the one softbox position that fixes all of them.",
    id: "019a0000-0000-7000-8000-000000000401",
    mediaKind: "REEL" as const,
    mediaProductType: "REELS",
    mediaType: "VIDEO",
    publishedAt: "2026-07-29T22:15:00.000Z",
    sourceVideoState: "NONE" as const,
  },
  {
    caption: "Behind the scenes on the winter campaign shoot.",
    id: "019a0000-0000-7000-8000-000000000402",
    mediaKind: "REEL" as const,
    mediaProductType: "REELS",
    mediaType: "VIDEO",
    publishedAt: "2026-07-27T03:40:00.000Z",
    sourceVideoState: "READY" as const,
  },
  {
    caption: null,
    id: "019a0000-0000-7000-8000-000000000403",
    mediaKind: "IMAGE" as const,
    mediaProductType: "FEED",
    mediaType: "IMAGE",
    publishedAt: "2026-07-24T08:05:00.000Z",
    sourceVideoState: "PENDING_VALIDATION" as const,
  },
  {
    caption: "Studio reference board.",
    id: "019a0000-0000-7000-8000-000000000404",
    mediaKind: "UNSUPPORTED" as const,
    mediaProductType: null,
    mediaType: "STORY",
    publishedAt: "2026-07-21T11:30:00.000Z",
    sourceVideoState: "REJECTED" as const,
  },
];

/**
 * Browser tests run without a database. The fixture covers a Reel, a
 * captionless post and a retained unsupported type on one page, and honours the
 * search and kind filters so the no-matches state is reachable.
 */
function testSnapshot(
  filters: InstagramPostListFilters,
  cursor: string | null,
  now: Date,
): PostsSnapshot {
  const matching = filters.matchesNothing
    ? []
    : testPosts.filter(
        (post) =>
          (!filters.mediaKind || post.mediaKind === filters.mediaKind) &&
          (!filters.search ||
            (post.caption ?? "").toLowerCase().includes(filters.search.toLowerCase())) &&
          (!filters.instagramAccountId || filters.instagramAccountId === testAccountId),
      );

  return Object.freeze({
    accounts: Object.freeze([Object.freeze({ id: testAccountId, label: "@studioparallel" })]),
    hasAccount: true,
    list: Object.freeze({
      generatedAt: now.toISOString(),
      nextCursor: null,
      posts: Object.freeze(
        (cursor ? [] : matching).map((post) =>
          Object.freeze({
            caption: post.caption,
            id: post.id,
            instagramAccountId: testAccountId,
            lastImportedAt: "2026-07-31T02:00:00.000Z",
            mediaKind: post.mediaKind,
            mediaProductType: post.mediaProductType,
            mediaType: post.mediaType,
            permalink: `https://www.instagram.com/reel/${post.id.slice(-6)}/`,
            // Undecodable on purpose, so the browser test exercises the
            // expired-thumbnail fallback. A data URL fails immediately and
            // offline; an unresolvable host would make the test depend on DNS
            // timing rather than on the fallback working.
            providerThumbnailUrl: "data:image/jpeg;base64,dGhpcyBpcyBub3QgYW4gaW1hZ2U=",
            publishedAt: post.publishedAt,
            sourceVideoState: post.sourceVideoState,
          }),
        ),
      ),
      totalCount: cursor ? 0 : matching.length,
    }),
  });
}
