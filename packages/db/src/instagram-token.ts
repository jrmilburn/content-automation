import { evaluateInstagramTokenHealth, type InstagramTokenHealth } from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Credential health, atomic rotation and reauthorisation state.
 *
 * Ciphertext enters and leaves this module only as an opaque string; nothing
 * here decrypts, and no function returns credential material to a caller that
 * did not supply it. The safe projection deliberately cannot express it.
 *
 * Rotation is a compare-and-swap on `refreshedAt`, so two workers that both
 * obtain a new token from Meta cannot both write: the loser is told it lost
 * rather than silently replacing a newer credential with an older one.
 */

type TokenDatabase = PrismaClient;

/**
 * Mutations take an executor rather than a client and never open their own
 * transaction. The job handler passes the same transaction that marks its job
 * succeeded, so a rotation and the job that performed it commit together or not
 * at all — a crash cannot leave a rotated credential attached to a job that
 * will run again.
 */
type TokenExecutor = PrismaClient | Prisma.TransactionClient;

/** Purged credentials keep their row for audit but hold no usable material. */
export const purgedCredentialCiphertext = "";

export type InstagramCredentialMaintenanceRecord = Readonly<{
  accountId: string;
  apiVersion: string;
  ciphertext: string;
  connectionStatus: string;
  credentialId: string;
  expiresAt: Date | null;
  issuedAt: Date;
  keyVersion: number;
  providerAccountId: string;
  refreshedAt: Date | null;
  status: string;
  workspaceId: string;
}>;

export type InstagramConnectionHealth = Readonly<{
  accountId: string;
  connectionStatus: string;
  expiresAt: Date | null;
  grantedScopes: readonly string[];
  health: InstagramTokenHealth;
  lastSuccessfulSyncAt: Date | null;
  lastValidatedAt: Date | null;
  lastValidationErrorClass: string | null;
  username: string | null;
}>;

export type InstagramCredentialDue = Readonly<{
  accountId: string;
  credentialId: string;
  workspaceId: string;
}>;

const safeErrorClassPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

function tokenError(code: string, statusCode: number): OperationalError {
  return new OperationalError({
    code,
    errorClass: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "validation",
    statusCode,
  });
}

function assertSafeErrorClass(value: string): void {
  if (!safeErrorClassPattern.test(value)) {
    throw tokenError("CREDENTIAL_ERROR_CLASS_INVALID", 400);
  }
}

/**
 * Loads the account and its active credential for maintenance. Scoped by
 * workspace, so a crafted account identifier reads nothing.
 */
export async function loadInstagramCredentialForMaintenance(
  executor: TokenExecutor,
  context: WorkspaceContext,
  input: Readonly<{ accountId: string }>,
): Promise<InstagramCredentialMaintenanceRecord | null> {
  const credential = await executor.integrationCredential.findFirst({
    include: {
      account: {
        select: { apiVersion: true, connectionStatus: true, id: true, providerAccountId: true },
      },
    },
    orderBy: { issuedAt: "desc" },
    where: {
      accountId: input.accountId,
      integrationType: "INSTAGRAM",
      status: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (!credential) return null;

  return Object.freeze({
    accountId: credential.accountId,
    apiVersion: credential.account.apiVersion,
    ciphertext: credential.ciphertext,
    connectionStatus: credential.account.connectionStatus,
    credentialId: credential.id,
    expiresAt: credential.expiresAt,
    issuedAt: credential.issuedAt,
    keyVersion: credential.keyVersion,
    providerAccountId: credential.account.providerAccountId,
    refreshedAt: credential.refreshedAt,
    status: credential.status,
    workspaceId: credential.workspaceId,
  });
}

/**
 * Replaces a credential's material in place under a compare-and-swap.
 *
 * Rotating in place rather than superseding means no decryptable copy of the
 * previous token is left behind, and the one-active-credential index is never
 * momentarily violated. Returns false when another worker rotated first; the
 * caller must treat that as success-by-someone-else, not as a failure.
 */
export async function rotateInstagramCredential(
  executor: TokenExecutor,
  context: WorkspaceContext,
  input: Readonly<{
    ciphertext: string;
    credentialId: string;
    expectedRefreshedAt: Date | null;
    expiresAt: Date | null;
    keyVersion: number;
    refreshedAt: Date;
    tokenType: string;
  }>,
): Promise<boolean> {
  if (input.ciphertext.length === 0) throw tokenError("CREDENTIAL_CIPHERTEXT_EMPTY", 400);

  const rotated = await executor.integrationCredential.updateMany({
    data: {
      ciphertext: input.ciphertext,
      expiresAt: input.expiresAt,
      keyVersion: input.keyVersion,
      lastValidatedAt: input.refreshedAt,
      lastValidationErrorClass: null,
      refreshedAt: input.refreshedAt,
      tokenType: input.tokenType,
    },
    where: {
      id: input.credentialId,
      integrationType: "INSTAGRAM",
      // The swap: only the worker that read this exact value may write.
      refreshedAt: input.expectedRefreshedAt,
      status: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (rotated.count !== 1) return false;

  const credential = await executor.integrationCredential.findFirstOrThrow({
    select: { accountId: true },
    where: { id: input.credentialId, workspaceId: context.workspaceId },
  });

  await executor.instagramAccount.updateMany({
    data: { tokenExpiresAt: input.expiresAt },
    where: { id: credential.accountId, workspaceId: context.workspaceId },
  });

  return true;
}

/**
 * Stops provider work for an account and purges the unusable credential.
 *
 * Clearing `status` off `ACTIVE` removes the row from the one-active-credential
 * index, so `credentials.findActive` returns nothing and the sync handler
 * refuses to run. The ciphertext is purged in the same transaction because a
 * revoked or expired token has no further legitimate use.
 */
export async function requireInstagramReauthorisation(
  executor: TokenExecutor,
  context: WorkspaceContext,
  input: Readonly<{
    accountId: string;
    correlationId: string;
    credentialId: string;
    occurredAt: Date;
    reasonCode: string;
  }>,
): Promise<void> {
  assertSafeErrorClass(input.reasonCode);

  await executor.integrationCredential.updateMany({
    data: {
      ciphertext: purgedCredentialCiphertext,
      lastValidatedAt: input.occurredAt,
      lastValidationErrorClass: input.reasonCode,
      status: "REAUTHORISATION_REQUIRED",
    },
    where: {
      id: input.credentialId,
      status: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  await executor.instagramAccount.updateMany({
    data: { connectionStatus: "REAUTHORISATION_REQUIRED" },
    where: { id: input.accountId, workspaceId: context.workspaceId },
  });

  await executor.auditEvent.create({
    data: {
      action: "instagram.token.reauthorisation_required",
      actorService: "token-maintainer",
      actorType: "SERVICE",
      correlationId: input.correlationId,
      id: createId(),
      occurredAt: input.occurredAt,
      outcome: "BLOCKED",
      reasonCode: input.reasonCode,
      resourceId: input.accountId,
      resourceType: "instagram_account",
      workspaceId: context.workspaceId,
    },
  });
}

/** Records a successful probe without touching credential material. */
export async function recordInstagramCredentialValidation(
  executor: TokenExecutor,
  context: WorkspaceContext,
  input: Readonly<{ credentialId: string; validatedAt: Date }>,
): Promise<void> {
  await executor.integrationCredential.updateMany({
    data: { lastValidatedAt: input.validatedAt, lastValidationErrorClass: null },
    where: { id: input.credentialId, status: "ACTIVE", workspaceId: context.workspaceId },
  });
}

/**
 * Safe connection health for operations and settings surfaces.
 *
 * The projection cannot express ciphertext, so no caller can accidentally
 * render or log a token through it.
 */
export async function loadInstagramConnectionHealth(
  executor: TokenExecutor,
  context: WorkspaceContext,
  input: Readonly<{ accountId: string; now?: Date }>,
): Promise<InstagramConnectionHealth | null> {
  const now = input.now ?? new Date();

  const account = await executor.instagramAccount.findFirst({
    select: {
      connectionStatus: true,
      grantedScopes: true,
      id: true,
      lastSuccessfulSyncAt: true,
      tokenExpiresAt: true,
      username: true,
    },
    where: { id: input.accountId, workspaceId: context.workspaceId },
  });
  if (!account) return null;

  const credential = await executor.integrationCredential.findFirst({
    orderBy: { issuedAt: "desc" },
    select: {
      expiresAt: true,
      issuedAt: true,
      lastValidatedAt: true,
      lastValidationErrorClass: true,
      status: true,
    },
    where: {
      accountId: input.accountId,
      integrationType: "INSTAGRAM",
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze({
    accountId: account.id,
    connectionStatus: account.connectionStatus,
    expiresAt: credential?.expiresAt ?? account.tokenExpiresAt,
    grantedScopes: Object.freeze([...account.grantedScopes]),
    health: evaluateInstagramTokenHealth({
      credentialStatus: credential?.status ?? "REVOKED",
      expiresAt: credential?.expiresAt ?? account.tokenExpiresAt,
      issuedAt: credential?.issuedAt ?? now,
      now,
    }),
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
    lastValidatedAt: credential?.lastValidatedAt ?? null,
    lastValidationErrorClass: credential?.lastValidationErrorClass ?? null,
    username: account.username,
  });
}

/**
 * Finds active credentials worth probing, across workspaces.
 *
 * This is a system sweep like the job reconciler, so it is not workspace-scoped;
 * each row carries its workspace so the enqueue that follows is. Only
 * identifiers are selected — never ciphertext.
 */
export async function listInstagramCredentialsDueForMaintenance(
  database: TokenDatabase,
  input: Readonly<{ dueBefore: Date; limit: number }>,
): Promise<readonly InstagramCredentialDue[]> {
  const credentials = await database.integrationCredential.findMany({
    orderBy: { expiresAt: "asc" },
    select: { accountId: true, id: true, workspaceId: true },
    take: Math.min(Math.max(input.limit, 1), 200),
    where: {
      account: { connectionStatus: "ACTIVE" },
      integrationType: "INSTAGRAM",
      status: "ACTIVE",
      // A null expiry is included deliberately: an unknown expiry must be
      // probed rather than assumed to be far away.
      OR: [{ expiresAt: null }, { expiresAt: { lte: input.dueBefore } }],
    },
  });

  return Object.freeze(
    credentials.map((credential) =>
      Object.freeze({
        accountId: credential.accountId,
        credentialId: credential.id,
        workspaceId: credential.workspaceId,
      }),
    ),
  );
}
