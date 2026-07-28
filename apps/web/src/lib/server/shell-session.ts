import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import type { SessionPrincipal } from "@studio-parallel/db";
import { OperationalError } from "@studio-parallel/observability";
import { cookies } from "next/headers";

import { requireAuthenticatedActor } from "./session";

const testActor: SessionPrincipal = Object.freeze({
  internalUserId: "01900000-0000-7000-8000-000000000021",
  sessionVersion: 1,
  workspaceId: "01900000-0000-7000-8000-000000000001",
});

export async function requireShellActor(): Promise<SessionPrincipal> {
  const config = loadAuthConfig();

  if (config.APP_ENV === "test") {
    const testSession = (await cookies()).get("studio-test-session")?.value;
    if (testSession === "expired") throw accessDenied();
    return testActor;
  }

  return requireAuthenticatedActor();
}

function accessDenied(): OperationalError {
  return new OperationalError({
    code: "ACCESS_DENIED",
    errorClass: "authorisation",
    statusCode: 401,
  });
}
