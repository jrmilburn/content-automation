import { evaluateInstagramTokenHealth } from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import { purgedCredentialCiphertext } from "./instagram-token.js";
import type { InstagramConnectionHealth } from "./instagram-token.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Settings-facing account reads and the disconnect commit.
 *
 * The projection here is a superset of `loadInstagramConnectionHealth` — it adds
 * the identity and contract fields a configuration screen must show — and is
 * built the same way: an explicit `select` that cannot name `ciphertext`, so no
 * caller can render or log credential material through it.
 *
 * Nothing in this module decrypts. The disconnect commit is handed the outcome
 * of a provider revocation that its caller already attempted, because a network
 * call must not run inside the transaction that purges the credential.
 */

type AccountExecutor = PrismaClient | Prisma.TransactionClient;

/** Adds identity and contract detail to the shared safe health projection. */
export type InstagramAccountSummary = InstagramConnectionHealth &
  Readonly<{
    accountType: string;
    apiVersion: string;
    connectedAt: Date;
    mediaCount: number | null;
    /** Provider-assigned identifier. Not a secret, but not rendered in full. */
    providerAccountId: string;
  }>;

/** Whether the provider was told to drop the grant, and whether it accepted. */
export const instagramRevocationOutcomes = ["SUCCEEDED", "FAILED", "NOT_ATTEMPTED"] as const;

export type InstagramRevocationOutcome = (typeof instagramRevocationOutcomes)[number];

export type InstagramDisconnectResult = Readonly<{
  /** True when this call performed the purge rather than finding it already done. */
  changed: boolean;
  revocation: InstagramRevocationOutcome;
}>;

export const instagramDisconnectedAction = "instagram.connection.disconnected";
export const instagramAccountResourceType = "instagram_account";

const accountSelect = {
  accountType: true,
  apiVersion: true,
  connectionStatus: true,
  createdAt: true,
  grantedScopes: true,
  id: true,
  lastSuccessfulSyncAt: true,
  mediaCount: true,
  providerAccountId: true,
  tokenExpiresAt: true,
  username: true,
} as const;

const credentialSelect = {
  accountId: true,
  expiresAt: true,
  issuedAt: true,
  lastValidatedAt: true,
  lastValidationErrorClass: true,
  status: true,
} as const;

/**
 * Lists every account in the workspace with its safe health summary.
 *
 * One query per table rather than per account: the settings screen is a small
 * list and this keeps it to two round trips regardless of how many accounts a
 * workspace grows to. The latest credential per account wins, ordered by
 * `issuedAt` so a purged-but-retained row cannot outrank a live one.
 */
export async function listInstagramAccountSummaries(
  executor: AccountExecutor,
  context: WorkspaceContext,
  input: Readonly<{ now?: Date }> = {},
): Promise<readonly InstagramAccountSummary[]> {
  const now = input.now ?? new Date();

  const accounts = await executor.instagramAccount.findMany({
    orderBy: { createdAt: "asc" },
    select: accountSelect,
    where: { workspaceId: context.workspaceId },
  });
  if (accounts.length === 0) return Object.freeze([]);

  const credentials = await executor.integrationCredential.findMany({
    orderBy: { issuedAt: "desc" },
    select: credentialSelect,
    where: {
      accountId: { in: accounts.map((account) => account.id) },
      integrationType: "INSTAGRAM",
      workspaceId: context.workspaceId,
    },
  });

  const latestByAccount = new Map<string, (typeof credentials)[number]>();
  for (const credential of credentials) {
    if (!latestByAccount.has(credential.accountId))
      latestByAccount.set(credential.accountId, credential);
  }

  return Object.freeze(
    accounts.map((account) => {
      const credential = latestByAccount.get(account.id);

      return Object.freeze({
        accountId: account.id,
        accountType: account.accountType,
        apiVersion: account.apiVersion,
        connectedAt: account.createdAt,
        connectionStatus: account.connectionStatus,
        expiresAt: credential?.expiresAt ?? account.tokenExpiresAt,
        grantedScopes: Object.freeze([...account.grantedScopes]),
        // An account with no credential row at all is treated as revoked rather
        // than healthy, matching loadInstagramConnectionHealth.
        health: evaluateInstagramTokenHealth({
          credentialStatus: credential?.status ?? "REVOKED",
          expiresAt: credential?.expiresAt ?? account.tokenExpiresAt,
          issuedAt: credential?.issuedAt ?? now,
          now,
        }),
        lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
        lastValidatedAt: credential?.lastValidatedAt ?? null,
        lastValidationErrorClass: credential?.lastValidationErrorClass ?? null,
        mediaCount: account.mediaCount,
        providerAccountId: account.providerAccountId,
        username: account.username,
      });
    }),
  );
}

/**
 * Stops provider work for an account and purges its credential material.
 *
 * Imported posts, sync runs and analyses are deliberately untouched: disconnect
 * ends the connection, it does not erase history. Full deletion is separate
 * security work with its own approval.
 *
 * Idempotent by construction. The purge is an `updateMany` filtered on
 * `status: "ACTIVE"`, so a repeat call matches zero rows and reports
 * `changed: false` instead of failing or writing a second audit of a purge that
 * did not happen. The ciphertext is blanked in the same statement that moves the
 * status off `ACTIVE` because a check constraint refuses any other combination.
 */
export async function commitInstagramDisconnect(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{
    accountId: string;
    actorUserId: string;
    correlationId: string;
    occurredAt: Date;
    revocation: InstagramRevocationOutcome;
  }>,
): Promise<InstagramDisconnectResult> {
  return database.$transaction(async (transaction) => {
    const purged = await transaction.integrationCredential.updateMany({
      data: {
        ciphertext: purgedCredentialCiphertext,
        lastValidatedAt: input.occurredAt,
        status: "REVOKED",
      },
      where: {
        accountId: input.accountId,
        integrationType: "INSTAGRAM",
        status: "ACTIVE",
        workspaceId: context.workspaceId,
      },
    });

    const account = await transaction.instagramAccount.updateMany({
      data: { connectionStatus: "DISCONNECTED", tokenExpiresAt: null },
      where: {
        connectionStatus: { not: "DISCONNECTED" },
        id: input.accountId,
        workspaceId: context.workspaceId,
      },
    });

    const changed = purged.count > 0 || account.count > 0;

    await transaction.auditEvent.create({
      data: {
        action: instagramDisconnectedAction,
        actorType: "USER",
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        id: createId(),
        occurredAt: input.occurredAt,
        outcome: changed ? "SUCCEEDED" : "NO_CHANGE",
        // The revocation result is recorded even when it failed, so an operator
        // can see that local material was purged while the provider still holds
        // a grant the user may need to remove in Instagram directly.
        reasonCode: `PROVIDER_REVOCATION_${input.revocation}`,
        resourceId: input.accountId,
        resourceType: instagramAccountResourceType,
        workspaceId: context.workspaceId,
      },
    });

    return Object.freeze({ changed, revocation: input.revocation });
  });
}
