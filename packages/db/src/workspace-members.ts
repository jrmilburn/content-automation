import type { PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Granting a colleague access to the workspace.
 *
 * Sign-in is invite-only: an approved Workspace domain is necessary but not
 * sufficient, and `authoriseOidcIdentity` refuses an email with no
 * `InternalUser` row. This is the only thing that creates one outside the seed,
 * which is why a colleague on the right domain could be refused nine times with
 * nothing an operator could do about it.
 *
 * The domain is re-checked here rather than trusted from the caller. A command
 * that could add any address would make the domain restriction advisory, and
 * the restriction is the whole authorisation model.
 */

export const memberGrantOutcomes = ["already_member", "granted", "wrong_domain"] as const;

export type MemberGrantOutcome = (typeof memberGrantOutcomes)[number];

export type MemberRole = "ADMIN" | "MEMBER";

export type GrantMemberResult =
  | Readonly<{ email: string; internalUserId: string; outcome: "already_member"; role: MemberRole }>
  | Readonly<{ email: string; internalUserId: string; outcome: "granted"; role: MemberRole }>
  | Readonly<{ approvedDomain: string; email: string; outcome: "wrong_domain" }>;

/**
 * Normalises an address the way the sign-in path does.
 *
 * Sign-in lower-cases and trims the verified email before matching, so a grant
 * that stored anything else would create a row nobody could ever sign in as.
 */
export function normaliseMemberEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isApprovedWorkspaceEmail(email: string, approvedDomain: string): boolean {
  const normalised = normaliseMemberEmail(email);
  const separator = normalised.indexOf("@");

  return (
    separator > 0 &&
    separator === normalised.lastIndexOf("@") &&
    normalised.slice(separator + 1) === approvedDomain.trim().toLowerCase()
  );
}

/**
 * Grants one email access, or reports why it did not.
 *
 * Re-running is safe and reports `already_member` rather than failing, because
 * an operator who is unsure whether a grant landed should be able to simply run
 * it again.
 *
 * The audit event records the new user's ID, not their address, matching how a
 * denied sign-in records a hash rather than an email.
 */
export async function grantWorkspaceMember(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{
    approvedDomain: string;
    correlationId: string;
    displayName?: string | undefined;
    email: string;
    role?: MemberRole | undefined;
  }>,
): Promise<GrantMemberResult> {
  const email = normaliseMemberEmail(input.email);

  if (!isApprovedWorkspaceEmail(email, input.approvedDomain)) {
    return Object.freeze({
      approvedDomain: input.approvedDomain.trim().toLowerCase(),
      email,
      outcome: "wrong_domain" as const,
    });
  }

  const role: MemberRole = input.role ?? "MEMBER";

  return database.$transaction(async (transaction) => {
    const existing = await transaction.internalUser.findFirst({
      select: { id: true, role: true },
      where: { email, workspaceId: context.workspaceId },
    });

    if (existing) {
      return Object.freeze({
        email,
        internalUserId: existing.id,
        outcome: "already_member" as const,
        role: existing.role as MemberRole,
      });
    }

    const id = createId();

    await transaction.internalUser.create({
      data: {
        displayName: input.displayName ?? null,
        email,
        id,
        role,
        workspaceId: context.workspaceId,
      },
    });

    await transaction.auditEvent.create({
      data: {
        action: "workspace.member.granted",
        actorService: "operator",
        actorType: "SERVICE",
        correlationId: input.correlationId,
        id: createId(),
        resourceId: id,
        resourceType: "internal_user",
        workspaceId: context.workspaceId,
      },
    });

    return Object.freeze({ email, internalUserId: id, outcome: "granted" as const, role });
  });
}
