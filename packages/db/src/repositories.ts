import type {
  AuditActorType,
  InternalUser,
  InternalUserStatus,
  Prisma,
  PrismaClient,
  SettingValueType,
  SystemSetting,
} from "./generated/prisma/client.js";
import { createId } from "./id.js";
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
            resourceId: input.resourceId ?? null,
            resourceType: input.resourceType,
          },
        });
      },
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
