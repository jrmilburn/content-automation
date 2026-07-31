import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { PostsError, PostsList } from "../../../components/posts-list";
import { parsePostsFilters, type PostsSearchParams } from "../../../lib/posts-list";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { loadPostsSnapshot } from "../../../lib/server/posts-data";

export default async function PostsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<PostsSearchParams> }>) {
  const parsed = parsePostsFilters(await searchParams);

  try {
    const snapshot = await loadPostsSnapshot(parsed.filters, parsed.cursor);
    return <PostsList snapshot={snapshot} values={parsed.values} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "posts.list.failed",
        stage: "triage",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <PostsError reference={requestContext.correlationId} />;
  }
}
