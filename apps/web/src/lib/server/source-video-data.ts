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

/**
 * What the page may say about an attached asset.
 *
 * Deliberately not the stored row. The object key, bucket, ETag and checksums
 * are storage provenance: they identify where private bytes live and belong
 * nowhere near a browser. What is left is what a person needs to decide what to
 * do next.
 */
export type SourceVideoAsset = Readonly<{
  bytes: number;
  contentType: string | null;
  durationMs: number | null;
  heightPx: number | null;
  id: string;
  /** Carried so the analyse control can name the post without a second query. */
  instagramPostId: string;
  /**
   * Where the bytes came from. Safe to expose — it names a route, not a
   * location, so it adds no storage provenance to what the browser can see.
   */
  origin: "PROVIDER_IMPORT" | "USER_UPLOAD";
  rejectionCode: string | null;
  state: "PENDING_VALIDATION" | "READY" | "REJECTED";
  uploadedAt: string;
  validatedAt: string | null;
  widthPx: number | null;
}>;

export type SourceVideoPost = Readonly<{
  /** The asset that decides what the page shows, or null when none exists. */
  asset: SourceVideoAsset | null;
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
          asset: null,
          id: postId,
          mediaKind: postId.endsWith("403") || postId.endsWith("404") ? "IMAGE" : "REEL",
        })
      : null;
  }

  const workspace = createWorkspaceContext(actor.workspaceId);
  const post = await getDatabase().instagramPost.findFirst({
    select: {
      id: true,
      mediaKind: true,
      // A post accumulates asset versions as uploads are replaced, so the newest
      // is the one that describes the post's current state. Ordering by creation
      // rather than by state keeps a fresh upload visible while it validates,
      // instead of showing an older rejection as though it were current.
      videoAssets: {
        orderBy: { createdAt: "desc" },
        select: {
          bytes: true,
          contentType: true,
          createdAt: true,
          durationMs: true,
          heightPx: true,
          id: true,
          origin: true,
          rejectionCode: true,
          state: true,
          validatedAt: true,
          widthPx: true,
        },
        take: 1,
      },
    },
    where: { id: postId, workspaceId: workspace.workspaceId },
  });

  if (post === null) return null;

  const asset = post.videoAssets[0];

  return Object.freeze({
    asset:
      asset === undefined
        ? null
        : Object.freeze({
            // A BigInt cannot cross the server boundary as-is.
            bytes: Number(asset.bytes),
            contentType: asset.contentType,
            durationMs: asset.durationMs,
            heightPx: asset.heightPx,
            id: asset.id,
            instagramPostId: post.id,
            origin: asset.origin,
            rejectionCode: asset.rejectionCode,
            state: asset.state,
            uploadedAt: asset.createdAt.toISOString(),
            validatedAt: asset.validatedAt?.toISOString() ?? null,
            widthPx: asset.widthPx,
          }),
    id: post.id,
    mediaKind: post.mediaKind,
  });
}
