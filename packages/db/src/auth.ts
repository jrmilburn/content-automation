import { createHash } from "node:crypto";

import { validate as validateUuid } from "uuid";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";

export const signInDenialReasons = [
  "AMBIGUOUS_IDENTITY",
  "INACTIVE_USER",
  "INACTIVE_WORKSPACE",
  "SUBJECT_MISMATCH",
  "UNLISTED_IDENTITY",
] as const;

export type SignInDenialReason = (typeof signInDenialReasons)[number];

export type VerifiedOidcIdentity = Readonly<{
  displayName?: string;
  email: string;
  subject: string;
}>;

export type SessionPrincipal = Readonly<{
  internalUserId: string;
  sessionVersion: number;
  workspaceId: string;
}>;

export type SignInDecision =
  | Readonly<{ allowed: true; principal: SessionPrincipal }>
  | Readonly<{ allowed: false; reason: SignInDenialReason }>;

type Transaction = Prisma.TransactionClient;

export async function authoriseOidcIdentity(
  database: PrismaClient,
  identity: VerifiedOidcIdentity,
  correlationId: string,
  now: Date = new Date(),
): Promise<SignInDecision> {
  return database.$transaction(async (transaction) => {
    const candidates = await transaction.internalUser.findMany({
      include: { workspace: true },
      take: 2,
      where: { email: identity.email },
    });

    if (candidates.length !== 1) {
      await recordDeniedSignIn(
        transaction,
        correlationId,
        candidates.length > 1 ? "AMBIGUOUS_IDENTITY" : "UNLISTED_IDENTITY",
        identity.email,
      );
      return {
        allowed: false,
        reason: candidates.length > 1 ? "AMBIGUOUS_IDENTITY" : "UNLISTED_IDENTITY",
      };
    }

    const candidate = candidates[0];
    if (!candidate) {
      return { allowed: false, reason: "UNLISTED_IDENTITY" };
    }

    if (candidate.workspace.status !== "ACTIVE") {
      await recordDeniedForCandidate(
        transaction,
        candidate.workspaceId,
        candidate.id,
        correlationId,
        "INACTIVE_WORKSPACE",
      );
      return { allowed: false, reason: "INACTIVE_WORKSPACE" };
    }

    if (candidate.status !== "ACTIVE") {
      await recordDeniedForCandidate(
        transaction,
        candidate.workspaceId,
        candidate.id,
        correlationId,
        "INACTIVE_USER",
      );
      return { allowed: false, reason: "INACTIVE_USER" };
    }

    if (candidate.oidcSubject && candidate.oidcSubject !== identity.subject) {
      await recordDeniedForCandidate(
        transaction,
        candidate.workspaceId,
        candidate.id,
        correlationId,
        "SUBJECT_MISMATCH",
      );
      return { allowed: false, reason: "SUBJECT_MISMATCH" };
    }

    const user = await transaction.internalUser.update({
      data: {
        displayName: identity.displayName ?? candidate.displayName,
        lastLoginAt: now,
        oidcSubject: candidate.oidcSubject ?? identity.subject,
      },
      where: { id: candidate.id },
    });

    await transaction.auditEvent.create({
      data: {
        id: createId(),
        action: "auth.sign_in.succeeded",
        actorType: "USER",
        actorUserId: user.id,
        correlationId,
        resourceId: user.id,
        resourceType: "internal_user",
        workspaceId: user.workspaceId,
      },
    });

    return {
      allowed: true,
      principal: {
        internalUserId: user.id,
        sessionVersion: user.sessionVersion,
        workspaceId: user.workspaceId,
      },
    };
  });
}

export async function findActiveSessionPrincipal(
  database: PrismaClient,
  principal: SessionPrincipal,
): Promise<SessionPrincipal | null> {
  const user = await database.internalUser.findFirst({
    select: { id: true, sessionVersion: true, workspaceId: true },
    where: {
      id: principal.internalUserId,
      sessionVersion: principal.sessionVersion,
      status: "ACTIVE",
      workspace: { status: "ACTIVE" },
      workspaceId: principal.workspaceId,
    },
  });

  return user
    ? {
        internalUserId: user.id,
        sessionVersion: user.sessionVersion,
        workspaceId: user.workspaceId,
      }
    : null;
}

export function parseSessionPrincipal(value: unknown): SessionPrincipal | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Record<string, unknown>;
  return typeof candidate.internalUserId === "string" &&
    validateUuid(candidate.internalUserId) &&
    typeof candidate.workspaceId === "string" &&
    validateUuid(candidate.workspaceId) &&
    typeof candidate.sessionVersion === "number" &&
    Number.isSafeInteger(candidate.sessionVersion) &&
    candidate.sessionVersion > 0
    ? {
        internalUserId: candidate.internalUserId,
        sessionVersion: candidate.sessionVersion,
        workspaceId: candidate.workspaceId,
      }
    : null;
}

export async function setInternalUserStatus(
  database: PrismaClient,
  input: Readonly<{
    actorUserId: string;
    correlationId: string;
    status: "ACTIVE" | "DISABLED";
    targetUserId: string;
    workspaceId: string;
  }>,
): Promise<SessionPrincipal | null> {
  return database.$transaction(async (transaction) => {
    const actor = await transaction.internalUser.findFirst({
      where: {
        id: input.actorUserId,
        status: "ACTIVE",
        workspace: { status: "ACTIVE" },
        workspaceId: input.workspaceId,
      },
    });
    const target = await transaction.internalUser.findFirst({
      where: { id: input.targetUserId, workspaceId: input.workspaceId },
    });

    if (!actor || !target) return null;

    const updated = await transaction.internalUser.update({
      data: {
        sessionVersion: { increment: 1 },
        status: input.status,
      },
      where: { id: target.id },
    });

    await transaction.auditEvent.create({
      data: {
        id: createId(),
        action: "auth.user_status.changed",
        actorType: "USER",
        actorUserId: actor.id,
        correlationId: input.correlationId,
        resourceId: target.id,
        resourceType: "internal_user",
        workspaceId: input.workspaceId,
      },
    });

    return {
      internalUserId: updated.id,
      sessionVersion: updated.sessionVersion,
      workspaceId: updated.workspaceId,
    };
  });
}

async function recordDeniedSignIn(
  transaction: Transaction,
  correlationId: string,
  reason: SignInDenialReason,
  email: string,
): Promise<void> {
  const workspaces = await transaction.workspace.findMany({ take: 2 });
  if (workspaces.length !== 1 || !workspaces[0]) return;

  await transaction.auditEvent.create({
    data: {
      id: createId(),
      action: "auth.sign_in.denied",
      actorService: "web",
      actorType: "SERVICE",
      correlationId,
      resourceId: hashEmail(email),
      resourceType: reason.toLowerCase(),
      workspaceId: workspaces[0].id,
    },
  });
}

async function recordDeniedForCandidate(
  transaction: Transaction,
  workspaceId: string,
  userId: string,
  correlationId: string,
  reason: SignInDenialReason,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      id: createId(),
      action: "auth.sign_in.denied",
      actorService: "web",
      actorType: "SERVICE",
      correlationId,
      resourceId: userId,
      resourceType: reason.toLowerCase(),
      workspaceId,
    },
  });
}

function hashEmail(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}
