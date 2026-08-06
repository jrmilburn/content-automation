import {
  postDossierCommentCap,
  type PostDossier,
  type PostDossierComment,
} from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Assembles post dossiers: the rows behind every question a reader actually
 * asks.
 *
 * The metric read deliberately takes each post's most recent snapshot rather
 * than one matched to a cohort age window. Cohort matching exists so two posts
 * can be compared fairly, and that is the statistics layer's job; a dossier
 * answers "what did this post do", where the newest observation is the honest
 * answer and a fourteen-day-old one selected for comparability is not. The
 * bucket the observation came from is carried alongside so the age is visible
 * rather than implied.
 *
 * `rawPayload` is never selected. The sanitised comment text and the validated
 * analysis are the supported representations; the provider payload is
 * provenance and has no business in a prompt.
 */

type DossierDatabase = PrismaClient;

export type PostDossierEntry = Readonly<{ dossier: PostDossier; postId: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an observation's value out of a stored analysis.
 *
 * Every leaf in the analysis contract is `{ value, availability, ... }`, and a
 * non-available observation carries a null value. Reading the value alone is
 * therefore already correct: an unobserved field arrives as null and is
 * omitted, rather than rendering as the word "unknown" beside real findings.
 *
 * Exported because the post detail screen reads the same leaves out of the same
 * column. A second copy of this traversal would be a second place for the
 * observation shape to be misread, and the two readers would disagree about
 * what "not observed" looks like exactly when it matters.
 */
export function readObservationString(result: unknown, path: readonly string[]): string | null {
  let cursor: unknown = result;
  for (const segment of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  if (!isRecord(cursor)) return null;

  const value = cursor["value"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Loads dossiers for a scope, newest first.
 *
 * Only posts with a published analysis are returned: a post nothing has looked
 * at has no pillar, no hook and no transcript, so it would arrive as a row of
 * unknowns that costs tokens and carries nothing.
 */
export async function loadPostDossiers(
  database: DossierDatabase,
  context: WorkspaceContext,
  input: Readonly<{
    instagramAccountId: string | null;
    limit: number;
    /**
     * The exact posts to load, when the caller has already chosen them.
     *
     * The strategy selects its posts under a filter this function does not
     * share — an analysis has to be analytics-eligible to be argued from — so
     * asking for "the newest N analysed posts" would return a different set
     * from the one the manifest is being built for. The two populations overlap
     * heavily, which is what makes the bug quiet: the manifest would carry a
     * dossier for most posts and a bare one-line summary for whichever ones an
     * ineligible analysis had displaced, with nothing to say why.
     */
    postIds?: readonly string[] | undefined;
    publishedFrom?: Date | undefined;
    publishedTo?: Date | undefined;
  }>,
): Promise<readonly PostDossierEntry[]> {
  if (input.postIds !== undefined && input.postIds.length === 0) return Object.freeze([]);

  const posts = await database.instagramPost.findMany({
    orderBy: { publishedAt: "desc" },
    select: {
      caption: true,
      currentAnalysis: {
        select: {
          contentFormat: true,
          contentPillar: true,
          ctaType: true,
          durationSeconds: true,
          hookCategory: true,
          presenterMode: true,
          result: true,
        },
      },
      id: true,
      publishedAt: true,
      snapshots: {
        orderBy: { capturedAt: "desc" },
        select: {
          ageBucket: true,
          averageWatchTimeMs: true,
          comments: true,
          likes: true,
          reach: true,
          saves: true,
          shares: true,
          totalInteractions: true,
          views: true,
        },
        take: 1,
      },
    },
    take: input.limit,
    where: {
      currentAnalysisId: { not: null },
      ...(input.postIds === undefined ? {} : { id: { in: [...input.postIds] } }),
      ...(input.instagramAccountId === null
        ? {}
        : { instagramAccountId: input.instagramAccountId }),
      ...(input.publishedFrom === undefined && input.publishedTo === undefined
        ? {}
        : {
            publishedAt: {
              ...(input.publishedFrom === undefined ? {} : { gte: input.publishedFrom }),
              ...(input.publishedTo === undefined ? {} : { lte: input.publishedTo }),
            },
          }),
      workspaceId: context.workspaceId,
    },
  });

  if (posts.length === 0) return Object.freeze([]);

  const postIds = posts.map((post) => post.id);

  // Two queries rather than a nested take, because Prisma cannot order a
  // nested relation by one column and cap it per parent in the same read
  // without emitting a correlated subquery per post.
  const [comments, counts] = await Promise.all([
    database.instagramComment.findMany({
      orderBy: [{ likeCount: "desc" }, { publishedAt: "desc" }],
      select: { instagramPostId: true, likeCount: true, text: true, username: true },
      where: { instagramPostId: { in: postIds }, workspaceId: context.workspaceId },
    }),
    database.instagramComment.groupBy({
      _count: { _all: true },
      by: ["instagramPostId"],
      where: { instagramPostId: { in: postIds }, workspaceId: context.workspaceId },
    }),
  ]);

  const commentsByPost = new Map<string, PostDossierComment[]>();
  for (const comment of comments) {
    const bucket = commentsByPost.get(comment.instagramPostId) ?? [];
    if (bucket.length >= postDossierCommentCap) continue;
    bucket.push(
      Object.freeze({
        likeCount: comment.likeCount,
        text: comment.text,
        username: comment.username,
      }),
    );
    commentsByPost.set(comment.instagramPostId, bucket);
  }

  const countByPost = new Map(counts.map((row) => [row.instagramPostId, row._count._all]));

  return Object.freeze(
    posts.map((post) => {
      const analysis = post.currentAnalysis;
      const snapshot = post.snapshots[0];

      return Object.freeze({
        dossier: Object.freeze({
          ageWindow: snapshot?.ageBucket.toLowerCase() ?? null,
          caption: post.caption,
          commentCount: countByPost.get(post.id) ?? 0,
          comments: Object.freeze(commentsByPost.get(post.id) ?? []),
          contentFormat: analysis?.contentFormat ?? null,
          contentPillar: analysis?.contentPillar ?? null,
          ctaType: analysis?.ctaType ?? null,
          durationSeconds:
            analysis?.durationSeconds === null || analysis?.durationSeconds === undefined
              ? null
              : Math.round(Number(analysis.durationSeconds)),
          hookCategory: analysis?.hookCategory ?? null,
          hookText: readObservationString(analysis?.result, ["content", "hook", "text"]),
          metrics: Object.freeze({
            averageWatchTimeMs: snapshot?.averageWatchTimeMs ?? null,
            comments: snapshot?.comments ?? null,
            likes: snapshot?.likes ?? null,
            reach: snapshot?.reach ?? null,
            saves: snapshot?.saves ?? null,
            shares: snapshot?.shares ?? null,
            totalInteractions: snapshot?.totalInteractions ?? null,
            views: snapshot?.views ?? null,
          }),
          postId: post.id,
          presenterMode: analysis?.presenterMode ?? null,
          publishedAt: post.publishedAt.toISOString().slice(0, 10),
          transcript: readObservationString(analysis?.result, ["content", "transcript"]),
        }),
        postId: post.id,
      });
    }),
  );
}
