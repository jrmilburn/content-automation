import type {
  AuditActorType,
  InstagramAccount,
  InstagramAccountType,
  InstagramConnectionStatus,
  IntegrationCredential,
  IntegrationType,
  InternalUser,
  InternalUserStatus,
  Prisma,
  PrismaClient,
  SettingValueType,
  SystemSetting,
} from "./generated/prisma/client.js";
import { createId } from "./id.js";
import { purgedCredentialCiphertext } from "./instagram-token.js";
import type { WorkspaceContext } from "./workspace-context.js";

type DatabaseExecutor = PrismaClient | Prisma.TransactionClient;

export type AuditActor =
  | Readonly<{ type: "USER"; userId: string }>
  | Readonly<{ service: string; type: "SERVICE" }>
  | Readonly<{ type: "SYSTEM" }>;

export type WorkspaceRepositories = ReturnType<typeof createWorkspaceRepositories>;

export function createWorkspaceRepositories(database: DatabaseExecutor, context: WorkspaceContext) {
  const workspaceWhere = { workspaceId: context.workspaceId } as const;

  return {
    audit: {
      record: async (input: {
        action: string;
        actor: AuditActor;
        afterHash?: string;
        beforeHash?: string;
        correlationId: string;
        outcome?: string;
        reasonCode?: string;
        resourceId?: string;
        resourceType: string;
      }) => {
        const actor = toAuditActor(input.actor);

        return database.auditEvent.create({
          data: {
            id: createId(),
            workspaceId: context.workspaceId,
            action: input.action,
            actorType: actor.actorType,
            actorService: actor.actorService,
            actorUserId: actor.actorUserId,
            afterHash: input.afterHash ?? null,
            beforeHash: input.beforeHash ?? null,
            correlationId: input.correlationId,
            outcome: input.outcome ?? null,
            reasonCode: input.reasonCode ?? null,
            resourceId: input.resourceId ?? null,
            resourceType: input.resourceType,
          },
        });
      },
      /**
       * Counts an actor's recent attempts at one action. Connection initiation is
       * audited on every attempt, so the audit trail is itself the rate-limit
       * source and no separate counter table is needed. This matches the existing
       * `(workspace_id, actor_user_id, action, occurred_at)` index.
       */
      countRecentByActor: (input: {
        action: string;
        actorUserId: string;
        since: Date;
      }): Promise<number> =>
        database.auditEvent.count({
          where: {
            ...workspaceWhere,
            action: input.action,
            actorUserId: input.actorUserId,
            occurredAt: { gte: input.since },
          },
        }),
    },
    settings: {
      createVersion: async (input: {
        changedBy: Exclude<AuditActor, { type: "SYSTEM" }>;
        changeReason: string;
        effectiveAt: Date;
        key: string;
        value: Prisma.InputJsonValue;
        valueType: SettingValueType;
        version: number;
      }): Promise<SystemSetting> => {
        const actor = toAuditActor(input.changedBy);

        return database.systemSetting.create({
          data: {
            id: createId(),
            workspaceId: context.workspaceId,
            key: input.key,
            valueType: input.valueType,
            value: input.value,
            version: input.version,
            effectiveAt: input.effectiveAt,
            changedByService: actor.actorService,
            changedByUserId: actor.actorUserId,
            changeReason: input.changeReason,
          },
        });
      },
      findLatest: (key: string): Promise<SystemSetting | null> =>
        database.systemSetting.findFirst({
          orderBy: [{ version: "desc" }, { effectiveAt: "desc" }],
          where: { ...workspaceWhere, key },
        }),
    },
    instagramAccounts: {
      findByProviderAccountId: (providerAccountId: string): Promise<InstagramAccount | null> =>
        database.instagramAccount.findUnique({
          where: {
            workspaceId_providerAccountId: {
              workspaceId: context.workspaceId,
              providerAccountId,
            },
          },
        }),
      /**
       * Reconnecting the same provider account updates the existing row rather
       * than creating a second one, so the connection is idempotent and the
       * unique `(workspace_id, provider_account_id)` constraint is never hit.
       */
      upsertConnected: (input: {
        accountType: InstagramAccountType;
        apiVersion: string;
        grantedScopes: readonly string[];
        mediaCount?: number | null;
        providerAccountId: string;
        tokenExpiresAt?: Date | null;
        username?: string | null;
      }): Promise<InstagramAccount> => {
        const shared = {
          accountType: input.accountType,
          apiVersion: input.apiVersion,
          connectionStatus: "ACTIVE" as InstagramConnectionStatus,
          grantedScopes: [...input.grantedScopes],
          mediaCount: input.mediaCount ?? null,
          tokenExpiresAt: input.tokenExpiresAt ?? null,
          username: input.username ?? null,
        };

        return database.instagramAccount.upsert({
          create: {
            ...shared,
            id: createId(),
            workspaceId: context.workspaceId,
            providerAccountId: input.providerAccountId,
          },
          update: shared,
          where: {
            workspaceId_providerAccountId: {
              workspaceId: context.workspaceId,
              providerAccountId: input.providerAccountId,
            },
          },
        });
      },
    },
    credentials: {
      findActive: (input: {
        accountId: string;
        integrationType: IntegrationType;
      }): Promise<IntegrationCredential | null> =>
        database.integrationCredential.findFirst({
          where: {
            ...workspaceWhere,
            accountId: input.accountId,
            integrationType: input.integrationType,
            status: "ACTIVE",
          },
        }),
      /**
       * Supersedes any active credential before activating the replacement, so a
       * reconnect never leaves two usable tokens. The filtered unique index on
       * `(integration_type, account_id) WHERE status = 'ACTIVE'` makes concurrent
       * callers collide here rather than both activating.
       *
       * The superseded row is retained for audit but its ciphertext is purged in
       * the same statement: a replaced token has no further legitimate use, and
       * keeping a decryptable copy would only widen what a database or backup
       * disclosure exposes. A database check constraint enforces that only an
       * `ACTIVE` row holds material.
       *
       * Ciphertext is written but is never used as an idempotency input.
       */
      activate: async (input: {
        accountId: string;
        ciphertext: string;
        expiresAt?: Date | null;
        integrationType: IntegrationType;
        issuedAt: Date;
        keyVersion: number;
        scopeHash: string;
        tokenType: string;
      }): Promise<IntegrationCredential> => {
        await database.integrationCredential.updateMany({
          data: { ciphertext: purgedCredentialCiphertext, status: "REVOKED" },
          where: {
            ...workspaceWhere,
            accountId: input.accountId,
            integrationType: input.integrationType,
            status: "ACTIVE",
          },
        });

        return database.integrationCredential.create({
          data: {
            id: createId(),
            workspaceId: context.workspaceId,
            accountId: input.accountId,
            ciphertext: input.ciphertext,
            expiresAt: input.expiresAt ?? null,
            integrationType: input.integrationType,
            issuedAt: input.issuedAt,
            keyVersion: input.keyVersion,
            scopeHash: input.scopeHash,
            status: "ACTIVE",
            tokenType: input.tokenType,
          },
        });
      },
    },
    users: {
      create: (input: {
        displayName?: string;
        email: string;
        oidcSubject?: string;
      }): Promise<InternalUser> =>
        database.internalUser.create({
          data: {
            id: createId(),
            workspaceId: context.workspaceId,
            displayName: input.displayName ?? null,
            email: input.email.trim().toLowerCase(),
            oidcSubject: input.oidcSubject ?? null,
          },
        }),
      findById: (id: string): Promise<InternalUser | null> =>
        database.internalUser.findFirst({
          where: { ...workspaceWhere, id },
        }),
      findByOidcSubject: (oidcSubject: string): Promise<InternalUser | null> =>
        database.internalUser.findUnique({
          where: {
            workspaceId_oidcSubject: {
              workspaceId: context.workspaceId,
              oidcSubject,
            },
          },
        }),
      findByEmail: (email: string): Promise<InternalUser | null> =>
        database.internalUser.findUnique({
          where: {
            workspaceId_email: {
              workspaceId: context.workspaceId,
              email: email.trim().toLowerCase(),
            },
          },
        }),
      setStatus: async (id: string, status: InternalUserStatus): Promise<InternalUser | null> => {
        const result = await database.internalUser.updateMany({
          data: {
            status,
            sessionVersion: { increment: 1 },
          },
          where: { ...workspaceWhere, id },
        });

        return result.count === 1
          ? database.internalUser.findFirst({ where: { ...workspaceWhere, id } })
          : null;
      },
    },
  };
}

export async function withWorkspaceTransaction<T>(
  database: PrismaClient,
  context: WorkspaceContext,
  operation: (repositories: WorkspaceRepositories) => Promise<T>,
): Promise<T> {
  return database.$transaction((transaction) =>
    operation(createWorkspaceRepositories(transaction, context)),
  );
}

function toAuditActor(actor: AuditActor): {
  actorService: string | null;
  actorType: AuditActorType;
  actorUserId: string | null;
} {
  switch (actor.type) {
    case "USER":
      return { actorService: null, actorType: "USER", actorUserId: actor.userId };
    case "SERVICE":
      return { actorService: actor.service, actorType: "SERVICE", actorUserId: null };
    case "SYSTEM":
      return { actorService: null, actorType: "SYSTEM", actorUserId: null };
  }
}
