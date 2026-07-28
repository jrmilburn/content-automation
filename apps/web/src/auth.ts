import { loadAuthConfig } from "@studio-parallel/config";
import { authoriseOidcIdentity, findActiveSessionPrincipal } from "@studio-parallel/db";
import NextAuth from "next-auth";

import { createAuthOptions } from "./lib/auth-options";
import { getDatabase } from "./lib/server/database";
import { webErrorMonitor, webLogger } from "./lib/server/observability";

const config = loadAuthConfig();

export const { auth, handlers, signIn, signOut } = NextAuth(
  createAuthOptions(config, {
    authoriseIdentity: (identity, correlationId) =>
      authoriseOidcIdentity(getDatabase(), identity, correlationId),
    logger: webLogger,
    monitor: webErrorMonitor,
    validateSessionPrincipal: (principal) => findActiveSessionPrincipal(getDatabase(), principal),
  }),
);
