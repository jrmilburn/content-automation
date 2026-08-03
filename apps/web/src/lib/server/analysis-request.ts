import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  isUuidV7,
  requestPostAnalysis,
  type AnalysisRequestRefusal,
  type SessionPrincipal,
} from "@studio-parallel/db";

import { getDatabase } from "./database";

/**
 * Asking for one post's source video to be analysed.
 *
 * A crafted identifier is refused exactly as an absent post is, so the action
 * cannot be used to learn which posts exist in another workspace.
 *
 * Browser tests run without a database, so the same fixture identifiers the
 * source-video page uses are answered directly. The branch is keyed on APP_ENV,
 * which configuration only permits to be "test" outside deployed environments.
 */

export type AnalysisRequestResult =
  | Readonly<{ alreadyRequested: boolean; queued: true }>
  | Readonly<{ queued: false; reason: AnalysisRequestRefusal }>;

export async function requestAnalysisForPost(
  actor: SessionPrincipal,
  input: Readonly<{ correlationId: string; postId: string }>,
): Promise<AnalysisRequestResult> {
  if (!isUuidV7(input.postId)) {
    return Object.freeze({ queued: false, reason: "post_not_found" });
  }

  if (loadAuthConfig().APP_ENV === "test") {
    return Object.freeze({ alreadyRequested: false, queued: true });
  }

  const outcome = await requestPostAnalysis(
    getDatabase(),
    createWorkspaceContext(actor.workspaceId),
    { correlationId: input.correlationId, instagramPostId: input.postId },
  );

  return outcome.requested
    ? Object.freeze({ alreadyRequested: !outcome.created, queued: true as const })
    : Object.freeze({ queued: false as const, reason: outcome.reason });
}
