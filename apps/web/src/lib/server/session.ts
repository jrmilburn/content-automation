import "server-only";

import {
  findActiveAdminPrincipal,
  findActiveSessionPrincipal,
  parseSessionPrincipal,
  type SessionPrincipal,
} from "@studio-parallel/db";
import { OperationalError } from "@studio-parallel/observability";

import { auth } from "../../auth";
import { getDatabase } from "./database";

export async function requireAuthenticatedActor(): Promise<SessionPrincipal> {
  const session = await auth();
  const principal = parseSessionPrincipal(session?.user);

  if (!principal) {
    throw accessDenied();
  }

  const activePrincipal = await findActiveSessionPrincipal(getDatabase(), principal);
  if (!activePrincipal) {
    throw accessDenied();
  }

  return activePrincipal;
}

/**
 * Connecting or replacing provider credentials is an admin-only action. The role
 * is verified server-side against current database state, and a non-admin is
 * refused with the same error as an unauthenticated caller so the endpoint does
 * not reveal whether a session was valid but under-privileged.
 */
export async function requireAdminActor(): Promise<SessionPrincipal> {
  const session = await auth();
  const principal = parseSessionPrincipal(session?.user);

  if (!principal) {
    throw accessDenied();
  }

  const adminPrincipal = await findActiveAdminPrincipal(getDatabase(), principal);
  if (!adminPrincipal) {
    throw accessDenied();
  }

  return adminPrincipal;
}

function accessDenied(): OperationalError {
  return new OperationalError({
    code: "ACCESS_DENIED",
    errorClass: "authorisation",
    statusCode: 401,
  });
}
