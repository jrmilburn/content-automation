import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  countInstagramCommentsByPost,
  createWorkspaceContext,
  isUuidV7,
  loadInstagramComments,
  readObservationString,
  type SessionPrincipal,
} from "@studio-parallel/db";
import type { InstagramMediaKind } from "@studio-parallel/domain";

import { getDatabase } from "./database";

/**
 * Everything one imported post is known to be, in one read.
 *
 * The lookup is workspace-scoped and a crafted identifier is treated exactly
 * like an absent one, so the page cannot be used to learn which posts exist in
 * another workspace — the same rule the source-video page applies, for the same
 * reason.
 *
 * The metric read takes the post's most recent snapshot rather than one matched
 * to a cohort age window, as the dossier read does. Cohort matching exists so
 * two posts can be compared fairly, and that is the statistics layer's job; this
 * page answers "what did this post do", where the newest observation is the
 * honest answer. The bucket it came from travels with it so the age is visible
 * rather than implied.
 *
 * `rawPayload` is never selected, on the post, the snapshot or a comment. It is
 * provider provenance and has no business in a browser; the sanitised comment
 * text and the validated analysis are the supported representations.
 */

/**
 * A capped page of comments.
 *
 * Higher than the dossier's cap because a reader is not paying tokens per
 * comment and can scroll, but still capped: a post with four thousand comments
 * would otherwise put four thousand of them into one server-rendered document.
 * The stored total is loaded separately and shown beside the list, so a capped
 * page never reads as the whole of what an audience said.
 */
const commentCap = 60;

export type PostDetailMetrics = Readonly<{
  /** The snapshot's age bucket, lowercased to match the presentation labels. */
  ageWindow: string;
  averageWatchTimeMs: number | null;
  capturedAt: string;
  comments: number | null;
  likes: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  views: number | null;
}>;

export type PostDetailAnalysis = Readonly<{
  analysedAt: string;
  contentFormat: string | null;
  contentPillar: string | null;
  ctaType: string | null;
  durationSeconds: number | null;
  hookCategory: string | null;
  presenterMode: string | null;
  /**
   * Model-generated from the video's audio, never a verbatim record. Null when
   * the analysis reported the observation unavailable, which is not the same as
   * an empty transcript and must not be shown as one.
   */
  transcript: string | null;
}>;

export type PostDetailComment = Readonly<{
  id: string;
  likeCount: number | null;
  /** Present on a reply. Not a foreign key: the parent may not be imported. */
  parentProviderCommentId: string | null;
  providerCommentId: string;
  publishedAt: string;
  /** A stranger's words. Untrusted text, rendered as text and never as markup. */
  text: string;
  username: string | null;
}>;

export type PostDetail = Readonly<{
  /** The analysis a reader should see, or null when none is current. */
  analysis: PostDetailAnalysis | null;
  caption: string | null;
  /** Every comment stored, which is not the number carried — the list is capped. */
  commentCount: number;
  comments: readonly PostDetailComment[];
  id: string;
  mediaKind: InstagramMediaKind;
  /** Carried only so the kind reads the same here as it does on the list. */
  mediaProductType: string | null;
  /** Null when no snapshot has ever been captured for this post. */
  metrics: PostDetailMetrics | null;
  permalink: string | null;
  publishedAt: string;
}>;

export async function loadPostDetail(
  actor: SessionPrincipal,
  postId: string,
): Promise<PostDetail | null> {
  if (!isUuidV7(postId)) {
    return null;
  }

  if (loadAuthConfig().APP_ENV === "test") {
    return testPostDetail(postId);
  }

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);

  const post = await database.instagramPost.findFirst({
    select: {
      caption: true,
      currentAnalysis: {
        select: {
          analysedAt: true,
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
      mediaKind: true,
      mediaProductType: true,
      permalink: true,
      publishedAt: true,
      snapshots: {
        orderBy: { capturedAt: "desc" },
        select: {
          ageBucket: true,
          averageWatchTimeMs: true,
          capturedAt: true,
          comments: true,
          likes: true,
          reach: true,
          saves: true,
          shares: true,
          views: true,
        },
        take: 1,
      },
    },
    where: { id: postId, workspaceId: context.workspaceId },
  });

  if (post === null) return null;

  // Only once the post is known to belong to the caller. Both reads are scoped
  // by the same workspace again anyway, so a mistake here cannot widen them.
  const [comments, counts] = await Promise.all([
    loadInstagramComments(database, context, { instagramPostId: post.id, limit: commentCap }),
    countInstagramCommentsByPost(database, context, [post.id]),
  ]);

  const analysis = post.currentAnalysis;
  const snapshot = post.snapshots[0];

  return Object.freeze({
    analysis:
      analysis === null
        ? null
        : Object.freeze({
            analysedAt: analysis.analysedAt.toISOString(),
            contentFormat: analysis.contentFormat,
            contentPillar: analysis.contentPillar,
            ctaType: analysis.ctaType,
            // A Decimal cannot cross the server boundary as-is, and a duration
            // is reported to the second.
            durationSeconds:
              analysis.durationSeconds === null
                ? null
                : Math.round(Number(analysis.durationSeconds)),
            hookCategory: analysis.hookCategory,
            presenterMode: analysis.presenterMode,
            transcript: readObservationString(analysis.result, ["content", "transcript"]),
          }),
    caption: post.caption,
    commentCount: counts.get(post.id) ?? 0,
    comments: Object.freeze(
      comments.map((comment) =>
        Object.freeze({
          id: comment.id,
          likeCount: comment.likeCount,
          parentProviderCommentId: comment.parentProviderCommentId,
          providerCommentId: comment.providerCommentId,
          publishedAt: comment.publishedAt.toISOString(),
          text: comment.text,
          username: comment.username,
        }),
      ),
    ),
    id: post.id,
    mediaKind: post.mediaKind,
    mediaProductType: post.mediaProductType,
    metrics:
      snapshot === undefined
        ? null
        : Object.freeze({
            ageWindow: snapshot.ageBucket.toLowerCase(),
            averageWatchTimeMs: snapshot.averageWatchTimeMs,
            capturedAt: snapshot.capturedAt.toISOString(),
            comments: snapshot.comments,
            likes: snapshot.likes,
            reach: snapshot.reach,
            saves: snapshot.saves,
            shares: snapshot.shares,
            views: snapshot.views,
          }),
    permalink: post.permalink,
    publishedAt: post.publishedAt.toISOString(),
  });
}

/**
 * Deterministic detail for browser and accessibility runs, which have no
 * database. The identifiers are the posts list fixture's, so the link from a
 * card resolves.
 *
 * Post 401 carries every section, including a metric the provider did not
 * report, a reply whose parent is in the list and a reply whose parent is not.
 * Post 403 carries none of them, so the three "nothing stored" states are
 * reachable without a real import having happened.
 */
function testPostDetail(postId: string): PostDetail | null {
  return testDetails[postId] ?? null;
}

const testDetails: Readonly<Record<string, PostDetail>> = Object.freeze({
  "019a0000-0000-7000-8000-000000000401": Object.freeze({
    analysis: Object.freeze({
      analysedAt: "2026-07-30T04:00:00.000Z",
      contentFormat: "educational_how_to",
      contentPillar: "process_and_craft",
      ctaType: "follow",
      durationSeconds: 42,
      hookCategory: "question",
      presenterMode: "founder_on_camera",
      transcript:
        "Three lighting mistakes flatten a product shot. The first is putting the key light straight on. The second is forgetting the background. The third is a softbox that is too small for the subject.",
    }),
    caption:
      "Three lighting mistakes that flatten a product shot, and the one softbox position that fixes all of them.",
    commentCount: 4,
    comments: Object.freeze([
      Object.freeze({
        id: "019a0000-0000-7000-8000-000000000501",
        likeCount: 12,
        parentProviderCommentId: null,
        providerCommentId: "c-100",
        publishedAt: "2026-07-30T01:00:00.000Z",
        text: "The softbox position tip changed how I shoot every product now.",
        username: "lena.makes",
      }),
      Object.freeze({
        id: "019a0000-0000-7000-8000-000000000502",
        likeCount: 3,
        parentProviderCommentId: "c-100",
        providerCommentId: "c-101",
        publishedAt: "2026-07-30T02:00:00.000Z",
        text: "Same here — the background one was the mistake I kept making.",
        username: "studioparallel",
      }),
      Object.freeze({
        id: "019a0000-0000-7000-8000-000000000503",
        likeCount: null,
        parentProviderCommentId: "c-999",
        providerCommentId: "c-102",
        publishedAt: "2026-07-30T03:00:00.000Z",
        text: "Agreed, and it works for flat lay too.",
        username: null,
      }),
    ]),
    id: "019a0000-0000-7000-8000-000000000401",
    mediaKind: "REEL",
    mediaProductType: "REELS",
    metrics: Object.freeze({
      ageWindow: "day_7",
      // The provider reported no average watch time for this post, which is
      // what makes the "not measured" row reachable in a browser run.
      averageWatchTimeMs: null,
      capturedAt: "2026-08-05T22:15:00.000Z",
      comments: 4,
      likes: 218,
      reach: 4_902,
      saves: 74,
      shares: 31,
      views: 8_140,
    }),
    permalink: "https://www.instagram.com/reel/000401/",
    publishedAt: "2026-07-29T22:15:00.000Z",
  }),
  "019a0000-0000-7000-8000-000000000402": Object.freeze({
    // Analysed, but the audio carried nothing the model could transcribe. A
    // separate state from "not analysed", and it must not read as an empty
    // transcript.
    analysis: Object.freeze({
      analysedAt: "2026-07-28T04:00:00.000Z",
      contentFormat: "behind_the_scenes",
      contentPillar: "process_and_craft",
      ctaType: "none",
      durationSeconds: 18,
      hookCategory: "visual_spectacle",
      presenterMode: "no_presenter",
      transcript: null,
    }),
    caption: "Behind the scenes on the winter campaign shoot.",
    commentCount: 0,
    comments: Object.freeze([]),
    id: "019a0000-0000-7000-8000-000000000402",
    mediaKind: "REEL",
    mediaProductType: "REELS",
    metrics: Object.freeze({
      ageWindow: "day_30",
      averageWatchTimeMs: 9_400,
      capturedAt: "2026-08-05T03:40:00.000Z",
      comments: 0,
      likes: 96,
      reach: 1_733,
      saves: 12,
      shares: 4,
      views: 2_410,
    }),
    permalink: "https://www.instagram.com/reel/000402/",
    publishedAt: "2026-07-27T03:40:00.000Z",
  }),
  "019a0000-0000-7000-8000-000000000403": Object.freeze({
    analysis: null,
    caption: null,
    commentCount: 0,
    comments: Object.freeze([]),
    id: "019a0000-0000-7000-8000-000000000403",
    mediaKind: "IMAGE",
    mediaProductType: "FEED",
    metrics: null,
    permalink: null,
    publishedAt: "2026-07-24T08:05:00.000Z",
  }),
  "019a0000-0000-7000-8000-000000000404": Object.freeze({
    analysis: null,
    caption: "Studio reference board.",
    commentCount: 0,
    comments: Object.freeze([]),
    id: "019a0000-0000-7000-8000-000000000404",
    mediaKind: "UNSUPPORTED",
    mediaProductType: null,
    // A snapshot exists and reported nothing. Every row reads "not measured",
    // which is the distinction the whole table is built around.
    metrics: Object.freeze({
      ageWindow: "import",
      averageWatchTimeMs: null,
      capturedAt: "2026-07-21T11:35:00.000Z",
      comments: null,
      likes: null,
      reach: null,
      saves: null,
      shares: null,
      views: null,
    }),
    permalink: "https://www.instagram.com/p/000404/",
    publishedAt: "2026-07-21T11:30:00.000Z",
  }),
});
