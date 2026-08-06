import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { PostDetailError, PostDetailScreen } from "../../../../components/post-detail";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";
import { loadPostDetail } from "../../../../lib/server/post-detail-data";
import { requireShellActor } from "../../../../lib/server/shell-session";

export const dynamic = "force-dynamic";

/**
 * Unified detail for one imported post.
 *
 * The outcome the source-video page deferred: identity, the latest metrics, the
 * current analysis with its transcript, and the imported comments, all in one
 * place so a reader does not have to hold four screens in their head. Uploading
 * a source video stays where it is — that page owns a write, and this one owns
 * a read.
 *
 * A post outside the caller's workspace and a malformed identifier both render
 * the not-found boundary, so the route cannot be used to learn what exists
 * elsewhere.
 */
export default async function PostDetailPage({
  params,
}: Readonly<{ params: Promise<Readonly<{ postId: string }>> }>) {
  const { postId } = await params;
  const actor = await requireShellActor();

  try {
    const post = await loadPostDetail(actor, postId);
    // Outside the try: `notFound()` works by throwing, and catching it here
    // would turn every missing post into a load failure with a reference code.
    if (post !== null) return <PostDetailScreen post={post} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "posts.detail.failed",
        stage: "triage",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <PostDetailError reference={requestContext.correlationId} />;
  }

  notFound();
}
