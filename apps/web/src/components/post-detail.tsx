import Link from "next/link";

import {
  analysisFacts,
  metricRows,
  presentCommentAuthor,
  presentCommentLikes,
  threadComments,
  type PostCommentThread,
} from "../lib/post-detail";
import { formatPublishedAt, presentMediaKind, sourceVideoHref } from "../lib/posts-list";
import type {
  PostDetail,
  PostDetailAnalysis,
  PostDetailComment,
  PostDetailMetrics,
} from "../lib/server/post-detail-data";
import { presentAgeWindow } from "../lib/trends";
import { PageHeader } from "./page-header";
import { ErrorSummary } from "./states";
import { StatusBadge } from "./status-badge";

/**
 * Everything this product knows about one post, on one screen.
 *
 * Four sections in the order a reader asks for them: what the post is, what it
 * did, what the analysis made of it, and what the audience said underneath. No
 * section disappears when it is empty — an absent "Performance" heading reads as
 * "nothing happened", which is indistinguishable from "nothing was captured",
 * and those need different next actions.
 *
 * Two of the sections carry text this product did not write. The transcript came
 * from a model reading the video's audio and is labelled as such above the text
 * itself, because a reader who has already taken it for a verbatim record will
 * quote it. The comments are strangers' words: they are rendered as text
 * children, never as markup, and nothing here touches `dangerouslySetInnerHTML`.
 */

export function PostDetailScreen({ post }: Readonly<{ post: PostDetail }>) {
  const kind = presentMediaKind(post);
  const published = formatPublishedAt(post.publishedAt);

  return (
    <div className="page-stack">
      <PageHeader
        description="Everything imported and inferred about this post, and what has not been captured."
        title={`${kind.label} published ${published}`}
      />

      <p className="post-detail__back">
        <Link href="/posts">Back to posts</Link>
      </p>

      <PostIdentity kind={kind} post={post} published={published} />
      <PostMetrics metrics={post.metrics} />
      <PostAnalysis analysis={post.analysis} postId={post.id} />
      <PostComments comments={post.comments} storedCount={post.commentCount} />
    </div>
  );
}

export function PostDetailError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader
        description="Everything imported and inferred about this post."
        title="Post detail"
      />
      <ErrorSummary
        action={{ href: "/posts", label: "Back to posts" }}
        correlationId={reference}
        description="This post could not be loaded. Nothing was changed and the imported data remains safe."
        title="Post did not load"
      />
    </div>
  );
}

function PostIdentity({
  kind,
  post,
  published,
}: Readonly<{
  kind: ReturnType<typeof presentMediaKind>;
  post: PostDetail;
  published: string;
}>) {
  // Whitespace is not a caption. Trimming here rather than in the loader keeps
  // the stored value exactly as Instagram returned it.
  const caption = post.caption?.trim() ?? "";

  return (
    <section aria-labelledby="post-identity-heading" className="post-detail__section">
      <h2 id="post-identity-heading">This post</h2>

      <dl className="post-detail__facts">
        <div>
          <dt>Published</dt>
          <dd>
            <time dateTime={post.publishedAt}>{published}</time>
          </dd>
        </div>
        <div>
          <dt>Media type</dt>
          <dd>
            <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>
          </dd>
        </div>
        <div>
          <dt>On Instagram</dt>
          <dd>
            {post.permalink === null ? (
              /* Meta omits the permalink for some media. Saying so is better
                 than an inert link that goes nowhere. */
              "No permalink was returned for this post"
            ) : (
              <a href={post.permalink} rel="noreferrer noopener" target="_blank">
                View on Instagram
                <span className="visually-hidden"> ({published}, opens in a new tab)</span>
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Source video</dt>
          <dd>
            <Link href={sourceVideoHref(post.id)}>Manage the source video</Link>
          </dd>
        </div>
      </dl>

      <h3>Caption</h3>
      {/* Shown whole. The list truncates because it shows twenty-four of them;
          this page shows one post, and cutting its caption would hide the thing
          every section below is about. */}
      <p className="post-detail__caption">{caption === "" ? "No caption" : caption}</p>
    </section>
  );
}

/**
 * What the post did, and what was never observed.
 *
 * A metric column is null when the provider reported no value. Meta documents an
 * unavailable insight as empty data rather than as a zero, so every unreported
 * metric reads "Not measured" and none of them reads "0". That distinction is
 * the point of the table: a zero is a finding a reader would act on, and an
 * absence is not.
 *
 * The age of the observation is stated above the numbers rather than beneath
 * them. Metrics at one hour and at thirty days are not comparable, and a reader
 * who has already drawn a conclusion has been misled by the time they reach a
 * footnote.
 */
function PostMetrics({ metrics }: Readonly<{ metrics: PostDetailMetrics | null }>) {
  if (metrics === null) {
    return (
      <section aria-labelledby="post-metrics-heading" className="post-detail__section">
        <h2 id="post-metrics-heading">Performance</h2>
        <p className="post-detail__empty">
          No metrics have been captured for this post yet. This is not a finding that the post
          reached nobody — nothing has been observed to report.
        </p>
      </section>
    );
  }

  const measured = presentAgeWindow(metrics.ageWindow);

  return (
    <section aria-labelledby="post-metrics-heading" className="post-detail__section">
      <h2 id="post-metrics-heading">Performance</h2>
      <p className="post-detail__measured">
        Measured {measured}, captured{" "}
        <time dateTime={metrics.capturedAt}>{formatPublishedAt(metrics.capturedAt)}</time>.
      </p>

      <table className="post-detail__metrics">
        <caption className="visually-hidden">
          Latest captured metrics for this post, measured {measured}
        </caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {metricRows(metrics).map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td data-measured={row.measured ? "yes" : "no"}>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="post-detail__note">
        A metric shown as not measured was not reported by Instagram for this post. It is not a
        count of zero.
      </p>
    </section>
  );
}

/**
 * What the analysis made of the post, transcript included.
 *
 * Only the current analysis is shown. A post accumulates analyses as it is
 * re-analysed, and the current pointer is the one a reader should see; listing
 * superseded ones beside it would offer two answers to one question.
 */
function PostAnalysis({
  analysis,
  postId,
}: Readonly<{ analysis: PostDetailAnalysis | null; postId: string }>) {
  if (analysis === null) {
    return (
      <section aria-labelledby="post-analysis-heading" className="post-detail__section">
        <h2 id="post-analysis-heading">Analysis</h2>
        <p className="post-detail__empty">
          This post has not been analysed. A source video has to be attached and checked before an
          analysis can run.
        </p>
        <p>
          <Link href={sourceVideoHref(postId)}>Attach or check the source video</Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="post-analysis-heading" className="post-detail__section">
      <h2 id="post-analysis-heading">Analysis</h2>
      <p className="post-detail__measured">
        Analysed{" "}
        <time dateTime={analysis.analysedAt}>{formatPublishedAt(analysis.analysedAt)}</time>.
      </p>

      <dl className="post-detail__facts">
        {analysisFacts(analysis).map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd data-recorded={fact.recorded ? "yes" : "no"}>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <h3>Transcript</h3>
      {/* Above the transcript rather than below it. A reader who has already
          read it as a record of what was said has been misled by the time they
          reach a note underneath. */}
      <p className="post-detail__note">
        <StatusBadge tone="information">Model-generated</StatusBadge>
        <span>
          Written by a model from the video&rsquo;s audio, not a verbatim record. It can mishear
          words, drop speech and omit anything that was not spoken aloud, so quote the video rather
          than this.
        </span>
      </p>
      {analysis.transcript === null ? (
        <p className="post-detail__empty">
          The analysis recorded no transcript for this post. That is not an empty transcript: the
          observation was reported as unavailable, which usually means there was no usable speech.
        </p>
      ) : (
        <p className="post-detail__transcript">{analysis.transcript}</p>
      )}
    </section>
  );
}

/**
 * What the audience wrote.
 *
 * The stored total is shown beside the list because the list is capped, and a
 * reader told what sixty comments say about a post that has four hundred would
 * draw a conclusion about an audience from a sixth of it.
 *
 * Replies are nested under the comment they answer. Meta returns replies whose
 * parent may fall outside the imported set, and the schema deliberately does not
 * make the parent id a foreign key for that reason, so an orphaned reply is a
 * normal state and is labelled rather than hidden.
 */
function PostComments({
  comments,
  storedCount,
}: Readonly<{ comments: readonly PostDetailComment[]; storedCount: number }>) {
  return (
    <section aria-labelledby="post-comments-heading" className="post-detail__section">
      <h2 id="post-comments-heading">Comments</h2>

      {storedCount === 0 ? (
        <p className="post-detail__empty">
          No comments have been imported for this post. Importing runs in the background, so a
          recent post may not have been read yet.
        </p>
      ) : (
        <>
          <p className="post-detail__measured">
            {storedCount} {storedCount === 1 ? "comment" : "comments"} imported
            {comments.length < storedCount
              ? `, ${String(comments.length)} shown here, most liked first.`
              : ", most liked first."}
          </p>
          <ol className="post-detail__comments">
            {threadComments(comments).map((thread) => (
              <CommentThreadItem key={thread.comment.id} thread={thread} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function CommentThreadItem({ thread }: Readonly<{ thread: PostCommentThread }>) {
  return (
    <li>
      <CommentBody comment={thread.comment} orphanedReply={thread.orphanedReply} />
      {thread.replies.length > 0 ? (
        <ol
          aria-label={`Replies to ${presentCommentAuthor(thread.comment.username)}`}
          className="post-detail__replies"
        >
          {thread.replies.map((reply) => (
            <li key={reply.id}>
              <CommentBody comment={reply} orphanedReply={false} />
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function CommentBody({
  comment,
  orphanedReply,
}: Readonly<{ comment: PostDetailComment; orphanedReply: boolean }>) {
  return (
    <div className="post-detail__comment">
      <p className="post-detail__comment-meta">
        <span className="post-detail__comment-author">
          {presentCommentAuthor(comment.username)}
        </span>
        <span>{presentCommentLikes(comment.likeCount)}</span>
        <time dateTime={comment.publishedAt}>{formatPublishedAt(comment.publishedAt)}</time>
      </p>
      {orphanedReply ? (
        <p className="post-detail__comment-orphan">
          Reply to a comment that was not imported with this post.
        </p>
      ) : null}
      {/* Untrusted third-party text. Rendered as a text child so React escapes
          it; there is no path here that would accept markup. */}
      <p className="post-detail__comment-text">{comment.text}</p>
    </div>
  );
}
