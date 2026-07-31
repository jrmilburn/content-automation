import "server-only";

import {
  createWorkspaceContext,
  createWorkspaceRepositories,
  enqueueBackgroundJob,
  findActiveAdminPrincipal,
  instagramAccountResourceType,
  instagramSyncRunActive,
  isUuidV7,
  type SessionPrincipal,
} from "@studio-parallel/db";
import { instagramManualSyncKey, instagramSyncPriority } from "@studio-parallel/domain";

import { getDatabase } from "./database";

/**
 * Operator-requested account sync.
 *
 * The request only enqueues work; the worker owns the import. Everything that
 * could be abused is checked server-side and in this order: administrator role
 * re-read from the database, a bounded attempt window, then a workspace-scoped
 * account lookup — so a crafted identifier is refused with the same reason as
 * an absent one and cannot be used to discover accounts in another workspace.
 */

export const syncRequestAction = "instagram.sync.requested";

/** Bounds how often one admin may request a sync. */
export const syncRequestLimit = 10;
export const syncRequestWindowSeconds = 300;

export type SyncRequestRefusalReason =
  "ACCOUNT_NOT_CONNECTED" | "ACCOUNT_NOT_FOUND" | "ADMIN_REQUIRED" | "RATE_LIMITED";

export type SyncRequestResult =
  | Readonly<{ queued: true; alreadyRunning: boolean }>
  | Readonly<{ queued: false; reason: SyncRequestRefusalReason }>;

export async function requestInstagramSync(input: {
  accountId: string;
  actor: SessionPrincipal;
  correlationId: string;
  now?: Date | undefined;
}): Promise<SyncRequestResult> {
  const { accountId, actor, correlationId, now = new Date() } = input;

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, context);

  const refuse = async (reason: SyncRequestRefusalReason): Promise<SyncRequestResult> => {
    await repositories.audit.record({
      action: syncRequestAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      outcome: "REFUSED",
      reasonCode: reason,
      ...(reason === "ACCOUNT_NOT_FOUND" ? {} : { resourceId: accountId }),
      resourceType: instagramAccountResourceType,
    });
    return Object.freeze({ queued: false as const, reason });
  };

  // Re-read from the database so a user demoted mid-session cannot act on a
  // stale claim.
  const admin = await findActiveAdminPrincipal(database, actor);
  if (!admin) return refuse("ADMIN_REQUIRED");

  const recentRequests = await repositories.audit.countRecentByActor({
    action: syncRequestAction,
    actorUserId: actor.internalUserId,
    since: new Date(now.getTime() - syncRequestWindowSeconds * 1000),
  });
  if (recentRequests >= syncRequestLimit) return refuse("RATE_LIMITED");

  if (!isUuidV7(accountId)) return refuse("ACCOUNT_NOT_FOUND");

  const account = await database.instagramAccount.findFirst({
    select: { connectionStatus: true, id: true },
    where: { id: accountId, workspaceId: actor.workspaceId },
  });
  if (!account) return refuse("ACCOUNT_NOT_FOUND");

  // Provider work on an unhealthy connection would fail in the worker and read
  // as a broken sync rather than as a connection needing attention.
  if (account.connectionStatus !== "ACTIVE") return refuse("ACCOUNT_NOT_CONNECTED");

  // A manual run already in flight is reported as such rather than enqueued
  // again; the partial unique index would refuse the second run anyway, and
  // that refusal would surface as a failed job instead of an answer.
  const alreadyRunning = await instagramSyncRunActive(database, context, {
    instagramAccountId: account.id,
    trigger: "MANUAL",
  });

  if (!alreadyRunning) {
    await enqueueBackgroundJob(database, context, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: instagramManualSyncKey(account.id, now),
      // An operator waiting on a request outranks a sweep that will come round
      // again on its own.
      priority: instagramSyncPriority("MANUAL"),
      queueName: "instagram.sync.account",
      resourceId: account.id,
      resourceType: instagramAccountResourceType,
    });
  }

  await repositories.audit.record({
    action: syncRequestAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    outcome: alreadyRunning ? "NO_CHANGE" : "QUEUED",
    resourceId: account.id,
    resourceType: instagramAccountResourceType,
  });

  return Object.freeze({ alreadyRunning, queued: true as const });
}
