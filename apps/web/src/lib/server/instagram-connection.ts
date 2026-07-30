import "server-only";

import {
  loadAuthConfig,
  loadCredentialEncryptionConfig,
  loadInstagramOAuthConfig,
  loadRuntimeConfig,
} from "@studio-parallel/config";
import {
  createWorkspaceContext,
  createWorkspaceRepositories,
  decodeMasterKey,
  encryptCredential,
  enqueueBackgroundJobInTransaction,
  hashGrantedScopes,
  withWorkspaceTransaction,
  type SessionPrincipal,
} from "@studio-parallel/db";
import {
  buildInstagramRedirectUri,
  createInstagramAuthorizationRequest,
  evaluateInstagramCallback,
  evaluateInstagramGrantedScopes,
  instagramApiVersion,
  instagramRequiredScopes,
  instagramStateLifetimeSeconds,
  isEligibleInstagramAccountType,
  openInstagramState,
  resolveTokenExpiry,
  sealInstagramState,
  type InstagramAccountType,
  type InstagramConnectionDenialReason,
} from "@studio-parallel/domain";

import { getDatabase } from "./database";
import {
  exchangeForLongLivedInstagramToken,
  exchangeInstagramAuthorizationCode,
  fetchInstagramIdentity,
  InstagramProviderError,
  type FetchLike,
} from "./instagram-oauth-client";

/**
 * Orchestrates the Instagram connection so the route handlers stay thin.
 *
 * Access tokens exist only as locals here: they are encrypted before the
 * database write and are never returned to a caller, logged, or included in a
 * response. Every failure resolves to a denial reason from the domain contract
 * so callers can audit without handling provider detail.
 */

export const connectionInitiatedAction = "instagram.connection.initiated";
export const connectionActivatedAction = "instagram.connection.activated";
export const connectionFailedAction = "instagram.connection.failed";
export const connectionResourceType = "instagram_account";

/** Bounds how often one admin may start the provider redirect. */
export const connectionAttemptLimit = 5;
export const connectionAttemptWindowSeconds = 300;

export type StartConnectionResult =
  | Readonly<{
      authorizeUrl: string;
      cookieMaxAgeSeconds: number;
      sealedState: string;
      started: true;
    }>
  | Readonly<{ reason: "RATE_LIMITED"; started: false }>;

export type CompleteConnectionResult =
  | Readonly<{ accountId: string; connected: true }>
  | Readonly<{ connected: false; reason: InstagramConnectionDenialReason | "RATE_LIMITED" }>;

function providerErrorToReason(error: InstagramProviderError): InstagramConnectionDenialReason {
  return error.errorClass === "authorisation" ? "CONSENT_CANCELLED" : "PROVIDER_ERROR";
}

export async function startInstagramConnection(input: {
  actor: SessionPrincipal;
  correlationId: string;
  now?: Date;
}): Promise<StartConnectionResult> {
  const { actor, correlationId, now = new Date() } = input;
  const runtime = loadRuntimeConfig();
  const oauth = loadInstagramOAuthConfig();
  const auth = loadAuthConfig();

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, context);

  const recentAttempts = await repositories.audit.countRecentByActor({
    action: connectionInitiatedAction,
    actorUserId: actor.internalUserId,
    since: new Date(now.getTime() - connectionAttemptWindowSeconds * 1000),
  });

  if (recentAttempts >= connectionAttemptLimit) {
    return Object.freeze({ reason: "RATE_LIMITED" as const, started: false });
  }

  const request = createInstagramAuthorizationRequest({
    appId: oauth.INSTAGRAM_APP_ID,
    now,
    publicOrigin: runtime.PUBLIC_ORIGIN,
  });

  // Audited before the redirect so an abandoned attempt still counts towards
  // the limit and leaves a trail.
  await repositories.audit.record({
    action: connectionInitiatedAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    resourceType: connectionResourceType,
  });

  return Object.freeze({
    authorizeUrl: request.authorizeUrl,
    cookieMaxAgeSeconds: instagramStateLifetimeSeconds,
    sealedState: sealInstagramState({
      expiresAt: request.expiresAt,
      internalUserId: actor.internalUserId,
      secret: auth.AUTH_SECRET,
      state: request.state,
    }),
    started: true,
  });
}

export async function completeInstagramConnection(input: {
  actor: SessionPrincipal;
  code?: string | null;
  correlationId: string;
  fetchImplementation?: FetchLike;
  now?: Date;
  providerError?: string | null;
  receivedState?: string | null;
  sealedState?: string | null;
}): Promise<CompleteConnectionResult> {
  const {
    actor,
    code,
    correlationId,
    fetchImplementation,
    now = new Date(),
    providerError,
    receivedState,
    sealedState,
  } = input;

  const runtime = loadRuntimeConfig();
  const oauth = loadInstagramOAuthConfig();
  const auth = loadAuthConfig();
  const encryption = loadCredentialEncryptionConfig();

  const database = getDatabase();
  const context = createWorkspaceContext(actor.workspaceId);

  const audit = async (reason: InstagramConnectionDenialReason) => {
    await createWorkspaceRepositories(database, context).audit.record({
      action: connectionFailedAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      reasonCode: reason,
      resourceType: connectionResourceType,
    });
    return Object.freeze({ connected: false as const, reason });
  };

  const opened = openInstagramState(sealedState, auth.AUTH_SECRET);

  // A state issued to a different admin must not be completable by this one.
  if (opened && opened.internalUserId !== actor.internalUserId) {
    return audit("STATE_MISMATCH");
  }

  const decision = evaluateInstagramCallback({
    code,
    now,
    providerError,
    receivedState,
    storedState: opened
      ? { consumed: false, expiresAt: opened.expiresAt, state: opened.state }
      : null,
  });

  if (!decision.allowed) {
    return audit(decision.reason);
  }

  const redirectUri = buildInstagramRedirectUri(runtime.PUBLIC_ORIGIN);

  let accessToken: string;
  let expiresAt: Date | null;
  let tokenType: string;
  let identityAccountType: string;
  let providerAccountId: string;
  let username: string | null;
  let mediaCount: number | null;
  let grantedScopes: readonly string[];

  try {
    const shortLived = await exchangeInstagramAuthorizationCode({
      appId: oauth.INSTAGRAM_APP_ID,
      appSecret: oauth.INSTAGRAM_APP_SECRET,
      code: decision.code,
      fetchImplementation,
      now,
      redirectUri,
    });

    const longLived = await exchangeForLongLivedInstagramToken({
      appSecret: oauth.INSTAGRAM_APP_SECRET,
      fetchImplementation,
      now,
      shortLivedToken: shortLived.accessToken,
    });

    accessToken = longLived.accessToken;
    expiresAt = longLived.expiresAt ?? resolveTokenExpiry(null, now);
    tokenType = longLived.tokenType;

    const identity = await fetchInstagramIdentity({ accessToken, fetchImplementation });
    identityAccountType = identity.accountType;
    providerAccountId = identity.providerAccountId;
    username = identity.username;
    mediaCount = identity.mediaCount;

    // Meta reports granted permissions on the code exchange; an empty list is
    // treated as the requested set only when the provider omitted the field.
    grantedScopes =
      shortLived.permissions.length > 0 ? shortLived.permissions : [...instagramRequiredScopes];
  } catch (error) {
    if (error instanceof InstagramProviderError) {
      return audit(providerErrorToReason(error));
    }
    throw error;
  }

  if (!isEligibleInstagramAccountType(identityAccountType)) {
    return audit("ACCOUNT_TYPE_INELIGIBLE");
  }

  const scopeEvaluation = evaluateInstagramGrantedScopes(grantedScopes);
  if (!scopeEvaluation.satisfied) {
    return audit("SCOPE_DOWNGRADED");
  }

  const sealed = (accountId: string) =>
    encryptCredential({
      context: { accountId, integrationType: "INSTAGRAM", workspaceId: actor.workspaceId },
      keyVersion: encryption.CREDENTIAL_ENCRYPTION_KEY_VERSION,
      masterKey: decodeMasterKey(encryption.CREDENTIAL_ENCRYPTION_KEY),
      plaintext: accessToken,
    });

  // Account, credential, audit and the bootstrap sync commit together, so a
  // failure cannot leave an account without an active credential.
  const accountId = await withWorkspaceTransaction(database, context, async (repositories) => {
    const account = await repositories.instagramAccounts.upsertConnected({
      accountType: identityAccountType as InstagramAccountType,
      apiVersion: instagramApiVersion,
      grantedScopes,
      mediaCount,
      providerAccountId,
      tokenExpiresAt: expiresAt,
      username,
    });

    const credential = sealed(account.id);
    await repositories.credentials.activate({
      accountId: account.id,
      ciphertext: credential.ciphertext,
      expiresAt,
      integrationType: "INSTAGRAM",
      issuedAt: now,
      keyVersion: credential.keyVersion,
      scopeHash: hashGrantedScopes(grantedScopes),
      tokenType,
    });

    await repositories.audit.record({
      action: connectionActivatedAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      resourceId: account.id,
      resourceType: connectionResourceType,
    });

    return account.id;
  });

  // Enqueued after activation so the worker always finds a usable credential.
  await database.$transaction((transaction) =>
    enqueueBackgroundJobInTransaction(transaction, context, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: `instagram-bootstrap-sync-${accountId}`,
      queueName: "instagram.sync.account",
      resourceId: accountId,
      resourceType: connectionResourceType,
    }),
  );

  return Object.freeze({ accountId, connected: true as const });
}
