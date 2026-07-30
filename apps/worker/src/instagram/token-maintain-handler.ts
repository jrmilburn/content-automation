import {
  createWorkspaceContext,
  decryptCredential,
  encryptCredential,
  loadInstagramCredentialForMaintenance,
  recordInstagramCredentialValidation,
  requireInstagramReauthorisation,
  rotateInstagramCredential,
  runIdempotentJobHandler,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  evaluateInstagramTokenHealth,
  instagramConnectionBlocked,
  JobHandlerFailure,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  parseCorrelationId,
  type CorrelationId,
  type JsonLogger,
} from "@studio-parallel/observability";

import {
  InstagramTokenError,
  refreshInstagramToken,
  validateInstagramToken,
  type FetchLike,
} from "./token-client.js";

/**
 * Keeps one Instagram credential usable, or stops provider work and asks for a
 * reconnect.
 *
 * Every database mutation happens inside the commit callback, in the same
 * transaction that marks the job succeeded. A crash between the provider call
 * and the commit therefore leaves no rotated credential attached to a job that
 * will run again, and no half-applied reauthorisation state.
 *
 * A revoked or expired token is not a job failure. The job did its work: it
 * determined the connection needs a human. Retrying could not change that, so
 * the outcome is recorded on the account and the job succeeds.
 */

export const instagramTokenQueue = { name: "instagram.token.maintain", version: 1 } as const;

const accountResourceType = "instagram_account";

export type InstagramTokenDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  fetchImplementation?: FetchLike | undefined;
  loadEncryption: () => Readonly<{ keyVersion: number; masterKeys: ReadonlyMap<number, Buffer> }>;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

export function createInstagramTokenMaintainHandler(
  dependencies: InstagramTokenDependencies,
): QueueHandlerRegistration {
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        ...(dependencies.acquireConcurrency
          ? { acquireConcurrency: dependencies.acquireConcurrency }
          : {}),
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: (execution) =>
          maintainCredential({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        // Every terminal path — rotation, validation and reauthorisation —
        // stamps `lastValidatedAt`, so one probe covers all of them.
        resultExists: async (executor) => {
          const job = await executor.backgroundJob.findFirst({
            select: { queuedAt: true, resourceId: true },
            where: { id: envelope.domainJobId, workspaceId: envelope.workspaceId },
          });
          if (!job?.resourceId) return false;

          const credential = await executor.integrationCredential.findFirst({
            select: { id: true },
            where: {
              accountId: job.resourceId,
              integrationType: "INSTAGRAM",
              lastValidatedAt: { gte: job.queuedAt },
              workspaceId: envelope.workspaceId,
            },
          });
          return credential !== null;
        },
        signal: context.signal,
      });
    },
    queue: instagramTokenQueue,
  });
}

type MaintainOptions = Readonly<{
  dependencies: InstagramTokenDependencies;
  envelope: QueueJobEnvelope;
  execution: JobHandlerExecutionContext;
  now: () => Date;
  workspace: ReturnType<typeof createWorkspaceContext>;
}>;

async function maintainCredential(options: MaintainOptions): Promise<TransactionalJobResult> {
  const { dependencies, envelope, execution, now, workspace } = options;
  const { database, logger } = dependencies;

  const correlationId = parseCorrelationId(envelope.correlationId);
  if (!correlationId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "TOKEN_CORRELATION_INVALID",
    });
  }

  await execution.recordStage("loading_credential");

  const job = await database.backgroundJob.findFirst({
    select: { resourceId: true, resourceType: true },
    where: { id: execution.jobId, workspaceId: workspace.workspaceId },
  });
  if (!job?.resourceId || job.resourceType !== accountResourceType) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "TOKEN_RESOURCE_INVALID",
    });
  }

  const credential = await loadInstagramCredentialForMaintenance(database, workspace, {
    accountId: job.resourceId,
  });
  if (!credential) {
    // The account was disconnected or never had a credential. Retrying cannot
    // create one, so this is surfaced rather than retried.
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "TOKEN_CREDENTIAL_MISSING",
    });
  }

  const logContext = {
    accountId: credential.accountId,
    correlationId,
    jobId: execution.jobId,
    workspaceId: workspace.workspaceId,
  } as const;

  const health = evaluateInstagramTokenHealth({
    credentialStatus: credential.status,
    expiresAt: credential.expiresAt,
    issuedAt: credential.issuedAt,
    now: now(),
  });

  // An expired or already-flagged credential cannot be refreshed by anyone.
  if (instagramConnectionBlocked(health.state)) {
    return reauthorisationResult({
      correlationId,
      credential,
      logContext,
      logger,
      now,
      reasonCode: health.state === "EXPIRED" ? "TOKEN_EXPIRED" : "TOKEN_UNUSABLE",
      workspace,
    });
  }

  const encryption = readEncryption(dependencies);
  const accessToken = decryptToken({ credential, encryption, workspace });

  await execution.recordStage("probing_provider");

  // Meta refuses to refresh a token younger than twenty-four hours, so a young
  // credential is probed instead of spending an attempt to be told that.
  const shouldRefresh = health.refreshDue && health.refreshEligible;

  try {
    if (!shouldRefresh) {
      await validateInstagramToken({
        accessToken,
        fetchImplementation: dependencies.fetchImplementation,
      });

      return Object.freeze({
        commit: async (transaction) => {
          await recordInstagramCredentialValidation(transaction, workspace, {
            credentialId: credential.credentialId,
            validatedAt: now(),
          });
        },
      });
    }

    const refreshed = await refreshInstagramToken({
      accessToken,
      fetchImplementation: dependencies.fetchImplementation,
      now: now(),
    });

    const sealed = encryptCredential({
      context: {
        accountId: credential.accountId,
        integrationType: "INSTAGRAM",
        workspaceId: workspace.workspaceId,
      },
      keyVersion: encryption.keyVersion,
      masterKey: requireMasterKey(encryption),
      plaintext: refreshed.accessToken,
    });

    return Object.freeze({
      commit: async (transaction) => {
        const rotated = await rotateInstagramCredential(transaction, workspace, {
          ciphertext: sealed.ciphertext,
          credentialId: credential.credentialId,
          // The compare-and-swap: another worker that rotated first wins.
          expectedRefreshedAt: credential.refreshedAt,
          expiresAt: refreshed.expiresAt,
          keyVersion: sealed.keyVersion,
          refreshedAt: now(),
          tokenType: refreshed.tokenType,
        });

        if (!rotated) {
          // Another worker installed a newer token. Recording the probe keeps
          // this job idempotent without overwriting their result.
          await recordInstagramCredentialValidation(transaction, workspace, {
            credentialId: credential.credentialId,
            validatedAt: now(),
          });
          logger.info("instagram.token.rotation_superseded", {
            ...logContext,
            outcome: "SUPERSEDED",
            stage: "probing_provider",
          });
          return;
        }

        logger.info("instagram.token.refreshed", {
          ...logContext,
          outcome: "REFRESHED",
          stage: "probing_provider",
        });
      },
    });
  } catch (error) {
    if (!(error instanceof InstagramTokenError)) throw error;

    switch (error.failure) {
      case "PERMISSION_REVOKED":
      case "REAUTHORISATION_REQUIRED":
        return reauthorisationResult({
          correlationId,
          credential,
          logContext,
          logger,
          now,
          reasonCode:
            error.failure === "PERMISSION_REVOKED" ? "PERMISSION_REVOKED" : "TOKEN_REJECTED",
          workspace,
        });
      case "TRANSIENT":
        throw new JobHandlerFailure({
          errorClass: "TRANSIENT",
          errorCode: "INSTAGRAM_TOKEN_UNAVAILABLE",
        });
      case "UNSUPPORTED":
        // The provider accepted the request shape but did not return a token.
        // Retrying will not change that, and it is not evidence of revocation.
        throw new JobHandlerFailure({
          errorClass: "UNKNOWN",
          errorCode: "INSTAGRAM_REFRESH_UNSUPPORTED",
        });
    }
  }
}

function reauthorisationResult(
  input: Readonly<{
    correlationId: CorrelationId;
    credential: Readonly<{ accountId: string; credentialId: string }>;
    logContext: Readonly<{
      accountId: string;
      correlationId: CorrelationId;
      jobId: string;
      workspaceId: string;
    }>;
    logger: JsonLogger;
    now: () => Date;
    reasonCode: string;
    workspace: ReturnType<typeof createWorkspaceContext>;
  }>,
): TransactionalJobResult {
  return Object.freeze({
    commit: async (transaction) => {
      await requireInstagramReauthorisation(transaction, input.workspace, {
        accountId: input.credential.accountId,
        correlationId: input.correlationId,
        credentialId: input.credential.credentialId,
        occurredAt: input.now(),
        reasonCode: input.reasonCode,
      });

      input.logger.warn("instagram.token.reauthorisation_required", {
        ...input.logContext,
        outcome: "BLOCKED",
        reasonCode: input.reasonCode,
        stage: "probing_provider",
      });
    },
  });
}

function readEncryption(
  dependencies: InstagramTokenDependencies,
): ReturnType<InstagramTokenDependencies["loadEncryption"]> {
  try {
    return dependencies.loadEncryption();
  } catch {
    // A missing deployment key is an operator problem, not a reason to tell a
    // user their perfectly good connection needs reconnecting.
    throw new JobHandlerFailure({
      errorClass: "UNKNOWN",
      errorCode: "TOKEN_ENCRYPTION_UNAVAILABLE",
    });
  }
}

function requireMasterKey(
  encryption: Readonly<{ keyVersion: number; masterKeys: ReadonlyMap<number, Buffer> }>,
): Buffer {
  const key = encryption.masterKeys.get(encryption.keyVersion);
  if (!key) {
    // The configured write version has no key, so a rotation would seal the new
    // token under something nothing can open.
    throw new JobHandlerFailure({
      errorClass: "UNKNOWN",
      errorCode: "TOKEN_ENCRYPTION_KEY_MISSING",
    });
  }
  return key;
}

function decryptToken(
  input: Readonly<{
    credential: Readonly<{ accountId: string; ciphertext: string }>;
    encryption: Readonly<{ masterKeys: ReadonlyMap<number, Buffer> }>;
    workspace: ReturnType<typeof createWorkspaceContext>;
  }>,
): string {
  try {
    return decryptCredential({
      context: {
        accountId: input.credential.accountId,
        integrationType: "INSTAGRAM",
        workspaceId: input.workspace.workspaceId,
      },
      masterKeys: input.encryption.masterKeys,
      sealed: input.credential.ciphertext,
    });
  } catch {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "TOKEN_CREDENTIAL_UNREADABLE",
    });
  }
}
