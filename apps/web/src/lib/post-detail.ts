import { presentFeaturePath, presentFeatureValue } from "@studio-parallel/domain";

import type {
  PostDetailAnalysis,
  PostDetailComment,
  PostDetailMetrics,
} from "./server/post-detail-data";

/**
 * Pure presentation for one post's detail screen.
 *
 * The whole of this module exists to keep two absences apart from a zero and
 * from each other. A metric column is null when the provider reported no value,
 * which Meta documents as empty data rather than as none — reading it as 0 turns
 * "we do not know" into "nobody did this", and that is a claim a reader would
 * then act on. An analysis field is null when the model could not observe it,
 * which is a different absence with a different cause, so it is worded
 * differently rather than collapsed into one "unknown".
 *
 * Nothing here escapes, strips or trims comment text. It is a stranger's words
 * and is rendered as text by React; the only safe handling is to leave it alone
 * and never put it near markup.
 */

/** What the provider did not report. Never rendered as a zero. */
export const notMeasured = "Not measured";

/** What the analysis could not observe. A different absence from a metric's. */
const notObserved = "Not observed";

const counts = new Intl.NumberFormat("en-AU");

export type PostMetricRow = Readonly<{
  key: string;
  label: string;
  /** False when the provider reported nothing for this metric. */
  measured: boolean;
  value: string;
}>;

/**
 * The metric table's rows, in the order the acceptance criteria name them.
 *
 * Every metric gets a row whether or not it was reported. Dropping the
 * unreported ones would leave a reader unable to tell a metric that came back
 * empty from one this product never asks for.
 */
export function metricRows(metrics: PostDetailMetrics): readonly PostMetricRow[] {
  return Object.freeze([
    countRow("views", "Views", metrics.views),
    countRow("reach", "Reach", metrics.reach),
    countRow("likes", "Likes", metrics.likes),
    countRow("comments", "Comments", metrics.comments),
    countRow("shares", "Shares", metrics.shares),
    countRow("saves", "Saves", metrics.saves),
    Object.freeze({
      key: "averageWatchTime",
      label: "Average watch time",
      measured: metrics.averageWatchTimeMs !== null,
      value:
        metrics.averageWatchTimeMs === null
          ? notMeasured
          : formatDurationMs(metrics.averageWatchTimeMs),
    }),
  ]);
}

export type PostAnalysisFact = Readonly<{
  label: string;
  /** False when the model reported the observation unavailable. */
  recorded: boolean;
  value: string;
}>;

/**
 * The analysis facets, labelled by the same names trends uses.
 *
 * The labels and the taxonomy wording come from the domain presenters rather
 * than from a second table here, so the pillar a reader sees on this page is
 * worded identically to the pillar they see in a comparison. Two spellings of
 * one stored value read as two different findings.
 */
export function analysisFacts(analysis: PostDetailAnalysis): readonly PostAnalysisFact[] {
  return Object.freeze([
    taxonomyFact("content.contentPillar", analysis.contentPillar),
    taxonomyFact("content.contentFormat", analysis.contentFormat),
    taxonomyFact("content.hook.category", analysis.hookCategory),
    taxonomyFact("content.presenterMode", analysis.presenterMode),
    taxonomyFact("callToAction.type", analysis.ctaType),
    Object.freeze({
      label: "Duration",
      recorded: analysis.durationSeconds !== null,
      value:
        analysis.durationSeconds === null
          ? notObserved
          : formatDurationMs(analysis.durationSeconds * 1_000),
    }),
  ]);
}

export type PostCommentThread = Readonly<{
  comment: PostDetailComment;
  /**
   * True when this is a reply whose parent is not in the page. The parent id is
   * deliberately not a foreign key — Meta returns replies whose parent falls
   * outside the imported set — so this is a normal state, not a defect, and the
   * screen has to say so rather than present the reply as a new thread.
   */
  orphanedReply: boolean;
  replies: readonly PostDetailComment[];
}>;

/**
 * Reassembles the two-level thread the flat rows encode.
 *
 * Replies are ordered oldest first inside a thread even though the page arrives
 * ordered by like count. The like ordering decides *which* comments are worth
 * carrying when the list is capped; it is not an order to read a conversation
 * in, and a reply shown above the reply it answers is simply wrong.
 */
export function threadComments(
  comments: readonly PostDetailComment[],
): readonly PostCommentThread[] {
  const loaded = new Set(comments.map((comment) => comment.providerCommentId));
  const repliesByParent = new Map<string, PostDetailComment[]>();
  const roots: PostDetailComment[] = [];

  for (const comment of comments) {
    const parent = comment.parentProviderCommentId;
    // A reply whose parent did not come back stays at the top level. Hiding it
    // would lose a stranger's words on the strength of a page boundary.
    if (parent !== null && parent !== comment.providerCommentId && loaded.has(parent)) {
      const bucket = repliesByParent.get(parent) ?? [];
      bucket.push(comment);
      repliesByParent.set(parent, bucket);
      continue;
    }

    roots.push(comment);
  }

  return Object.freeze(
    roots.map((comment) =>
      Object.freeze({
        comment,
        orphanedReply: comment.parentProviderCommentId !== null,
        replies: Object.freeze(
          (repliesByParent.get(comment.providerCommentId) ?? []).sort((left, right) =>
            left.publishedAt.localeCompare(right.publishedAt),
          ),
        ),
      }),
    ),
  );
}

/**
 * How a comment's author reads.
 *
 * An absent username is stated rather than filled in. Meta omits it for a
 * deleted or restricted account, and inventing a placeholder that looks like a
 * handle would attribute a stranger's words to a name nobody used.
 */
export function presentCommentAuthor(username: string | null): string {
  return username === null ? "Account not recorded" : `@${username}`;
}

/** An unreported like count is not zero likes, so it is not shown as zero. */
export function presentCommentLikes(likeCount: number | null): string {
  if (likeCount === null) return "Likes not recorded";

  return `${counts.format(likeCount)} ${likeCount === 1 ? "like" : "likes"}`;
}

/** The in-application route to one post's detail. */
export function postDetailHref(postId: string): string {
  return `/posts/${postId}`;
}

/**
 * A duration in whole seconds, and in minutes once it passes one.
 *
 * Rounded to the second because neither a watch time nor a video length is
 * reported or read at finer resolution, and a trailing decimal would suggest a
 * precision the underlying number does not carry.
 */
function formatDurationMs(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${counts.format(totalSeconds)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  return `${counts.format(minutes)}m ${String(totalSeconds % 60)}s`;
}

function countRow(key: string, label: string, value: number | null): PostMetricRow {
  return Object.freeze({
    key,
    label,
    measured: value !== null,
    // A measured zero is a real observation and reads as one. Only null is an
    // absence.
    value: value === null ? notMeasured : counts.format(value),
  });
}

function taxonomyFact(path: string, value: string | null): PostAnalysisFact {
  return Object.freeze({
    label: presentFeaturePath(path),
    recorded: value !== null,
    value: value === null ? notObserved : presentFeatureValue(path, value),
  });
}
