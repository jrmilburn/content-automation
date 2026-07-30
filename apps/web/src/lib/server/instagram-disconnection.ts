import "server-only";

import { loadCredentialEncryptionConfig } from "@studio-parallel/config";
import {
  commitInstagramDisconnect,
  createWorkspaceContext,
  createWorkspaceRepositories,
  decodeMasterKey,
  decryptCredential,
  findActiveAdminPrincipal,
  instagramAccountResourceType,
  instagramDisconnectedAction,
  isUuidV7,
  type InstagramRevocationOutcome,
  type SessionPrincipal,
} from "@studio-parallel/db";

import { getDatabase } from "./database";
import { type FetchLike, revokeInstagramAccess } from "./instagram-oauth-client";

/**
 * Admin-only Instagram disconnection.
 *
 * The order is deliberate and is the whole security argument of this module:
 * authorise, then attempt provider revocation with the still-readable token,
 * then purge locally. Revocation is best effort and its failure never prevents
 * the purge — an operator who asked to disconnect must not be left with a
 * usable token because Meta was unreachable.
 *
 * Every refusal is audited under the same action as a success so a denied
 * attempt is as visible as a completed one, and no branch returns provider text
 * or credential material to the caller.
 */

export const disconnectResourceType = instagramAccountResourceType;

/** Bounds how often one admin may run this against a workspace. */
export const disconnectAttemptLimit = 10;
export const disconnectAttemptWindowSeconds = 300;

export type DisconnectRefusalReason = "ACCOUNT_NOT_FOUND" | "ADMIN_REQUIRED" | "RATE_LIMITED";

export type DisconnectResult =
  | Readonly<{
      /** False when the account was already disconnected; the call is idempotent. */
      changed: boolean;
      disconnected: true;
      revocation: InstagramRevocationOutcome;
    }>
  | Readonly<{ disconnected: false; reason: DisconnectRefusalReason }>;

export async function disconnectInstagramAccount(input: {
  accountId: string;
  actor: SessionPrincipal;
  correlationId: string;
  fetchImplementation?: FetchLike | undefined;
  now?: Date | undefined;
}): Promise<DisconnectResult> {
  const { accountId, actor, correlationId, fetchImplementation, now = new Date() } = input;

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, context);

  const refuse = async (reason: DisconnectRefusalReason): Promise<DisconnectResult> => {
    await repositories.audit.record({
      action: instagramDisconnectedAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      outcome: "REFUSED",
      reasonCode: reason,
      // A crafted identifier is never echoed into the audit trail as a
      // resource, only as a refusal.
      ...(reason === "ACCOUNT_NOT_FOUND" ? {} : { resourceId: accountId }),
      resourceType: disconnectResourceType,
    });
    return Object.freeze({ disconnected: false as const, reason });
  };

  // The role is re-read from the database rather than trusted from the session,
  // so a user demoted mid-session cannot disconnect on a stale claim.
  const admin = await findActiveAdminPrincipal(database, actor);
  if (!admin) return refuse("ADMIN_REQUIRED");

  const recentAttempts = await repositories.audit.countRecentByActor({
    action: instagramDisconnectedAction,
    actorUserId: actor.internalUserId,
    since: new Date(now.getTime() - disconnectAttemptWindowSeconds * 1000),
  });
  if (recentAttempts >= disconnectAttemptLimit) return refuse("RATE_LIMITED");

  // A crafted or cross-workspace identifier reads nothing and is refused with
  // the same reason as a genuinely absent account, so the response cannot be
  // used to probe which accounts exist in other workspaces.
  if (!isUuidV7(accountId)) return refuse("ACCOUNT_NOT_FOUND");

  const account = await database.instagramAccount.findFirst({
    select: { id: true, providerAccountId: true },
    where: { id: accountId, workspaceId: actor.workspaceId },
  });
  if (!account) return refuse("ACCOUNT_NOT_FOUND");

  const revocation = await attemptRevocation({
    accountId: account.id,
    fetchImplementation,
    providerAccountId: account.providerAccountId,
    repositories,
    workspaceId: actor.workspaceId,
  });

  const result = await commitInstagramDisconnect(database, context, {
    accountId: account.id,
    actorUserId: actor.internalUserId,
    correlationId,
    occurredAt: now,
    revocation,
  });

  return Object.freeze({
    changed: result.changed,
    disconnected: true as const,
    revocation: result.revocation,
  });
}

/**
 * Attempts provider revocation, reducing every failure to a recorded outcome.
 *
 * An account with no active credential — already disconnected, or already
 * reauthorisation-required with its material purged — has nothing to revoke and
 * reports `NOT_ATTEMPTED` rather than a false failure. A credential that cannot
 * be decrypted is also `NOT_ATTEMPTED`: the local purge still proceeds, which is
 * the outcome that matters.
 */
async function attemptRevocation(input: {
  accountId: string;
  fetchImplementation?: FetchLike | undefined;
  providerAccountId: string;
  repositories: ReturnType<typeof createWorkspaceRepositories>;
  workspaceId: string;
}): Promise<InstagramRevocationOutcome> {
  const credential = await input.repositories.credentials.findActive({
    accountId: input.accountId,
    integrationType: "INSTAGRAM",
  });
  if (!credential) return "NOT_ATTEMPTED";

  let accessToken: string;
  try {
    const encryption = loadCredentialEncryptionConfig();
    accessToken = decryptCredential({
      context: {
        accountId: input.accountId,
        integrationType: "INSTAGRAM",
        workspaceId: input.workspaceId,
      },
      masterKeys: new Map([
        [
          encryption.CREDENTIAL_ENCRYPTION_KEY_VERSION,
          decodeMasterKey(encryption.CREDENTIAL_ENCRYPTION_KEY),
        ],
      ]),
      sealed: credential.ciphertext,
    });
  } catch {
    return "NOT_ATTEMPTED";
  }

  const revoked = await revokeInstagramAccess({
    accessToken,
    ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    providerAccountId: input.providerAccountId,
  });

  return revoked ? "SUCCEEDED" : "FAILED";
}
