import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  createWorkspaceRepositories,
  enqueueBackgroundJob,
  instagramPostResourceType,
  isUuidV7,
  type SessionPrincipal,
} from "@studio-parallel/db";
import { instagramMediaImportKey, isImportableInstagramMediaKind } from "@studio-parallel/domain";

import { getDatabase } from "./database";

/**
 * User-requested import of a post's own Instagram video as its source asset.
 *
 * The request only enqueues work; the worker owns the provider call and the
 * transfer. Checks run server-side and in this order: a bounded attempt window
 * first, then a workspace-scoped post lookup — so the limit itself cannot be
 * used to discover which posts exist, and a crafted identifier is refused with
 * the same reason as an absent one.
 *
 * This is not an administrator action. Uploading a source video is not either,
 * and importing the same post's own video is the same act of attaching a source
 * by a different route.
 */

export const mediaImportRequestAction = "instagram.media.import.requested";

/** Bounds how often one user may start an import. */
export const mediaImportRequestLimit = 20;
export const mediaImportRequestWindowSeconds = 300;

export type MediaImportRefusalReason =
  "ALREADY_HAS_SOURCE" | "NOT_A_VIDEO" | "POST_NOT_FOUND" | "RATE_LIMITED";

export type MediaImportResult =
  Readonly<{ queued: true }> | Readonly<{ queued: false; reason: MediaImportRefusalReason }>;

export async function requestInstagramMediaImport(input: {
  actor: SessionPrincipal;
  correlationId: string;
  now?: Date | undefined;
  postId: string;
}): Promise<MediaImportResult> {
  const { actor, correlationId, now = new Date(), postId } = input;

  // Browser tests run without a database. The queued answer is the one the page
  // needs in order to render its next state.
  if (loadAuthConfig().APP_ENV === "test") {
    return Object.freeze({ queued: true as const });
  }

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, context);

  const refuse = async (reason: MediaImportRefusalReason): Promise<MediaImportResult> => {
    await repositories.audit.record({
      action: mediaImportRequestAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      outcome: "REFUSED",
      reasonCode: reason,
      // A crafted identifier is never written into the audit trail as though it
      // named something real.
      ...(reason === "POST_NOT_FOUND" ? {} : { resourceId: postId }),
      resourceType: instagramPostResourceType,
    });
    return Object.freeze({ queued: false as const, reason });
  };

  const recentRequests = await repositories.audit.countRecentByActor({
    action: mediaImportRequestAction,
    actorUserId: actor.internalUserId,
    since: new Date(now.getTime() - mediaImportRequestWindowSeconds * 1000),
  });
  if (recentRequests >= mediaImportRequestLimit) return refuse("RATE_LIMITED");

  if (!isUuidV7(postId)) return refuse("POST_NOT_FOUND");

  const post = await database.instagramPost.findFirst({
    select: {
      id: true,
      mediaKind: true,
      videoAssets: {
        orderBy: { createdAt: "desc" },
        select: { state: true },
        take: 1,
      },
    },
    where: { id: postId, workspaceId: actor.workspaceId },
  });
  if (!post) return refuse("POST_NOT_FOUND");

  // Answered here rather than becoming a job that fails at the provider: an
  // image has no video to import, whatever the CDN would serve.
  if (!isImportableInstagramMediaKind(post.mediaKind)) return refuse("NOT_A_VIDEO");

  // Importing over a video that is already attached would be a replacement, and
  // replacement is a separate outcome with its own cleanup.
  const current = post.videoAssets[0];
  if (current && current.state !== "REJECTED") return refuse("ALREADY_HAS_SOURCE");

  // Anchored on the post with no time bucket, so pressing twice while the first
  // import is still queued is recognised as the same work rather than starting
  // a second download.
  await enqueueBackgroundJob(database, context, {
    correlationId,
    handlerVersion: 1,
    idempotencyKey: instagramMediaImportKey(post.id),
    queueName: "instagram.media.import",
    resourceId: post.id,
    resourceType: instagramPostResourceType,
  });

  await repositories.audit.record({
    action: mediaImportRequestAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    outcome: "QUEUED",
    resourceId: post.id,
    resourceType: instagramPostResourceType,
  });

  return Object.freeze({ queued: true as const });
}
