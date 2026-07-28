import "server-only";

import {
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

function accessDenied(): OperationalError {
  return new OperationalError({
    code: "ACCESS_DENIED",
    errorClass: "authorisation",
    statusCode: 401,
  });
}
