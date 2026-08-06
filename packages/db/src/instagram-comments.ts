import type { NormalisedInstagramComment } from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Persistence for imported Instagram comments.
 *
 * Comments are mutable in a way media is not: a body can be edited, a like
 * count moves constantly, and new ones keep arriving on a post that is years
 * old. So a re-import updates in place keyed by provider comment id, rather
 * than accumulating an observation per read the way a metric snapshot does.
 * `firstImportedAt` is preserved across updates, which is what lets a reader
 * tell a comment that arrived today from one that has been there since launch.
 *
 * Every write is scoped by the caller's workspace and by the post the caller
 * resolved, so a crafted comment identifier cannot attach text to another
 * workspace's post.
 */

type CommentDatabase = PrismaClient;

/**
 * The read projection. `rawPayload` is restricted provenance and is
 * deliberately absent: the sanitised `text` is the supported representation,
 * and the raw item still holds the provider's unsanitised original.
 */
export const instagramCommentSafeSelect = {
  firstImportedAt: true,
  id: true,
  instagramPostId: true,
  lastImportedAt: true,
  likeCount: true,
  parentProviderCommentId: true,
  providerCommentId: true,
  publishedAt: true,
  text: true,
  username: true,
  workspaceId: true,
} as const;

export type InstagramCommentSummary = Prisma.InstagramCommentGetPayload<{
  select: typeof instagramCommentSafeSelect;
}>;

export type CommitInstagramCommentsInput = Readonly<{
  comments: readonly NormalisedInstagramComment[];
  importedAt: Date;
  instagramPostId: string;
  rawApiVersion: string;
}>;

export type InstagramCommentsCommit = Readonly<{
  imported: number;
  updated: number;
}>;

/**
 * Commits one page of comments for one post.
 *
 * Unlike a media page there is no cursor to advance transactionally: comments
 * are addressed by provider id and re-reading a page is idempotent, so a crash
 * mid-import replays the page and converges rather than skipping it. That is
 * also why paging state is not persisted — resuming from the start is correct
 * and costs one extra page.
 */
export async function commitInstagramComments(
  database: CommentDatabase,
  context: WorkspaceContext,
  input: CommitInstagramCommentsInput,
): Promise<InstagramCommentsCommit> {
  if (input.comments.length === 0) {
    return Object.freeze({ imported: 0, updated: 0 });
  }

  return database.$transaction(async (transaction) => {
    const existing = await transaction.instagramComment.findMany({
      select: { id: true, providerCommentId: true },
      where: {
        instagramPostId: input.instagramPostId,
        providerCommentId: { in: input.comments.map((comment) => comment.providerCommentId) },
        workspaceId: context.workspaceId,
      },
    });
    const existingByProviderId = new Map(
      existing.map((comment) => [comment.providerCommentId, comment.id]),
    );

    let imported = 0;
    let updated = 0;

    for (const comment of input.comments) {
      const shared = {
        lastImportedAt: input.importedAt,
        likeCount: comment.likeCount,
        parentProviderCommentId: comment.parentProviderCommentId,
        publishedAt: comment.publishedAt,
        rawApiVersion: input.rawApiVersion,
        rawPayload: { ...comment.rawPayload } as Prisma.InputJsonValue,
        rawPayloadHash: comment.rawPayloadHash,
        text: comment.text,
        username: comment.username,
      };

      const existingId = existingByProviderId.get(comment.providerCommentId);
      if (existingId) {
        await transaction.instagramComment.update({ data: shared, where: { id: existingId } });
        updated += 1;
        continue;
      }

      await transaction.instagramComment.create({
        data: {
          ...shared,
          firstImportedAt: input.importedAt,
          id: createId(),
          instagramPostId: input.instagramPostId,
          providerCommentId: comment.providerCommentId,
          workspaceId: context.workspaceId,
        },
      });
      imported += 1;
    }

    return Object.freeze({ imported, updated });
  });
}

/**
 * Reads a post's comments for a dossier, most engaged first.
 *
 * Ordered by like count rather than recency because the list is capped and the
 * question a dossier answers is what an audience responded to. Recency ranks
 * within equal like counts, so an uncommented post still reads newest first.
 */
export async function loadInstagramComments(
  database: CommentDatabase,
  context: WorkspaceContext,
  input: Readonly<{ instagramPostId: string; limit: number }>,
): Promise<readonly InstagramCommentSummary[]> {
  const comments = await database.instagramComment.findMany({
    orderBy: [{ likeCount: "desc" }, { publishedAt: "desc" }],
    select: instagramCommentSafeSelect,
    take: input.limit,
    where: { instagramPostId: input.instagramPostId, workspaceId: context.workspaceId },
  });

  return Object.freeze(comments);
}

/**
 * Lists posts whose comments are worth re-reading.
 *
 * Bounded by publication age rather than by a per-post `due_at` column. A
 * comment can arrive on a post at any time, so there is no moment after which
 * one is finished the way a metric snapshot's age window closes — but activity
 * collapses quickly, and re-reading a three-year-old post daily would spend the
 * whole quota on posts nobody is looking at.
 *
 * Newest first, so a burst of publishing is covered before the tail. The
 * caller's key is bucketed by day, which is what stops a sweep running every
 * few minutes producing one job per sweep instead of one job per post per day.
 */
export async function listInstagramPostsDueForComments(
  database: CommentDatabase,
  input: Readonly<{ limit: number; publishedAfter: Date }>,
): Promise<readonly Readonly<{ postId: string; workspaceId: string }>[]> {
  const posts = await database.instagramPost.findMany({
    orderBy: { publishedAt: "desc" },
    select: { id: true, workspaceId: true },
    take: input.limit,
    where: {
      account: { connectionStatus: "ACTIVE" },
      publishedAt: { gte: input.publishedAfter },
    },
  });

  return Object.freeze(
    posts.map((post) => Object.freeze({ postId: post.id, workspaceId: post.workspaceId })),
  );
}

/**
 * Counts stored comments per post for a set of posts.
 *
 * Separate from the dossier read because a dossier caps what it carries, and a
 * reader told "12 comments" beside a list of five needs the twelve to be the
 * real total rather than the truncated one.
 */
export async function countInstagramCommentsByPost(
  database: CommentDatabase,
  context: WorkspaceContext,
  instagramPostIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (instagramPostIds.length === 0) return new Map();

  const counted = await database.instagramComment.groupBy({
    _count: { _all: true },
    by: ["instagramPostId"],
    where: {
      instagramPostId: { in: [...instagramPostIds] },
      workspaceId: context.workspaceId,
    },
  });

  return new Map(counted.map((row) => [row.instagramPostId, row._count._all]));
}
