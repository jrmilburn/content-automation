import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import { createWorkspaceContext, isUuidV7, type SessionPrincipal } from "@studio-parallel/db";

import { getDatabase } from "./database";

/**
 * Loads the one post an upload will attach to.
 *
 * The lookup is workspace-scoped and a crafted identifier is treated exactly
 * like an absent one, so the page cannot be used to learn which posts exist in
 * another workspace.
 *
 * Browser tests run without a database, so the same fixture identifiers the
 * posts list uses are resolved directly. The branch is keyed on APP_ENV, which
 * configuration only permits to be "test" outside deployed environments.
 */

export type SourceVideoPost = Readonly<{
  id: string;
  mediaKind: string;
}>;

const testPostIds = new Set([
  "019a0000-0000-7000-8000-000000000401",
  "019a0000-0000-7000-8000-000000000402",
  "019a0000-0000-7000-8000-000000000403",
  "019a0000-0000-7000-8000-000000000404",
]);

export async function loadSourceVideoPost(
  actor: SessionPrincipal,
  postId: string,
): Promise<SourceVideoPost | null> {
  if (!isUuidV7(postId)) {
    return null;
  }

  if (loadAuthConfig().APP_ENV === "test") {
    return testPostIds.has(postId)
      ? Object.freeze({
          id: postId,
          mediaKind: postId.endsWith("403") || postId.endsWith("404") ? "IMAGE" : "REEL",
        })
      : null;
  }

  const workspace = createWorkspaceContext(actor.workspaceId);
  const post = await getDatabase().instagramPost.findFirst({
    select: { id: true, mediaKind: true },
    where: { id: postId, workspaceId: workspace.workspaceId },
  });

  return post === null ? null : Object.freeze({ id: post.id, mediaKind: post.mediaKind });
}
