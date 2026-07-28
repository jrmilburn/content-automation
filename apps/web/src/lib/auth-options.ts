import type { AuthConfig } from "@studio-parallel/config";
import {
  parseSessionPrincipal,
  type SessionPrincipal,
  type SignInDecision,
} from "@studio-parallel/db";
import { evaluateGoogleOidcProfile, resolveSafeReturnUrl } from "@studio-parallel/domain";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

type AuthDependencies = Readonly<{
  authoriseIdentity(
    identity: Readonly<{ displayName?: string; email: string; subject: string }>,
    correlationId: CorrelationId,
  ): Promise<SignInDecision>;
  createCorrelationId?: () => CorrelationId;
  logger: JsonLogger;
  monitor: ErrorMonitor;
  now?: () => Date;
  validateSessionPrincipal(principal: SessionPrincipal): Promise<SessionPrincipal | null>;
}>;

export function createAuthOptions(
  config: AuthConfig,
  dependencies: AuthDependencies,
): NextAuthConfig {
  const useSecureCookies = config.APP_ENV !== "local" && config.APP_ENV !== "test";

  return {
    callbacks: {
      async jwt({ token, user }) {
        const principal = parseSessionPrincipal(user ?? token);
        if (!principal) return null;

        const now = Math.floor((dependencies.now?.() ?? new Date()).getTime() / 1000);
        const sessionStartedAt = user ? now : token.sessionStartedAt;
        if (
          typeof sessionStartedAt !== "number" ||
          !Number.isSafeInteger(sessionStartedAt) ||
          sessionStartedAt <= 0 ||
          now >= sessionStartedAt + config.AUTH_SESSION_MAX_AGE_SECONDS
        ) {
          return null;
        }

        const activePrincipal = await dependencies.validateSessionPrincipal(principal);
        if (!activePrincipal) return null;

        return {
          sub: activePrincipal.internalUserId,
          internalUserId: activePrincipal.internalUserId,
          sessionStartedAt,
          sessionVersion: activePrincipal.sessionVersion,
          workspaceId: activePrincipal.workspaceId,
        };
      },
      redirect({ url }) {
        return resolveSafeReturnUrl(url, config.PUBLIC_ORIGIN);
      },
      session({ session, token }) {
        const principal = parseSessionPrincipal(token);
        if (!principal) return { expires: session.expires };

        return {
          expires: session.expires,
          user: {
            id: principal.internalUserId,
            internalUserId: principal.internalUserId,
            sessionVersion: principal.sessionVersion,
            workspaceId: principal.workspaceId,
          },
        };
      },
      async signIn({ account, profile, user }) {
        const correlationId = (dependencies.createCorrelationId ?? createCorrelationId)();

        if (account?.provider !== "google") {
          dependencies.logger.warn("auth.sign_in.denied", {
            correlationId,
            errorClass: "authorisation",
            errorCode: "UNSUPPORTED_PROVIDER",
            expected: true,
            stage: "oidc_callback",
          });
          return false;
        }

        const profileDecision = evaluateGoogleOidcProfile(profile, config.GOOGLE_WORKSPACE_DOMAIN);

        if (!profileDecision.allowed) {
          dependencies.logger.warn("auth.sign_in.denied", {
            correlationId,
            errorClass: "authorisation",
            errorCode: profileDecision.reason,
            expected: true,
            stage: "oidc_claims",
          });
          return false;
        }

        try {
          const decision = await dependencies.authoriseIdentity(
            profileDecision.identity,
            correlationId,
          );

          if (!decision.allowed) {
            dependencies.logger.warn("auth.sign_in.denied", {
              correlationId,
              errorClass: "authorisation",
              errorCode: decision.reason,
              expected: true,
              stage: "allowlist",
            });
            return false;
          }

          Object.assign(user, decision.principal);
          dependencies.logger.info("auth.sign_in.succeeded", {
            correlationId,
            actorId: decision.principal.internalUserId,
            stage: "session_issued",
            workspaceId: decision.principal.workspaceId,
          });
          return true;
        } catch (error) {
          reportError(
            error,
            { correlationId, event: "auth.sign_in.failed", stage: "allowlist" },
            { logger: dependencies.logger, monitor: dependencies.monitor },
          );
          return false;
        }
      },
    },
    cookies: {
      sessionToken: {
        name: `${useSecureCookies ? "__Secure-" : ""}authjs.session-token`,
        options: {
          httpOnly: true,
          maxAge: config.AUTH_SESSION_MAX_AGE_SECONDS,
          path: "/",
          sameSite: "lax",
          secure: useSecureCookies,
        },
      },
    },
    debug: false,
    jwt: { maxAge: config.AUTH_SESSION_MAX_AGE_SECONDS },
    logger: {
      debug() {},
      error(error) {
        const correlationId = (dependencies.createCorrelationId ?? createCorrelationId)();
        reportError(
          error,
          { correlationId, event: "auth.library.failed", stage: "authjs" },
          { logger: dependencies.logger, monitor: dependencies.monitor },
        );
      },
      warn(code) {
        const correlationId = (dependencies.createCorrelationId ?? createCorrelationId)();
        dependencies.logger.warn("auth.library.warning", {
          correlationId,
          errorClass: "authentication",
          errorCode: typeof code === "string" ? code : "AUTH_WARNING",
          expected: true,
          stage: "authjs",
        });
      },
    },
    providers: [
      Google({
        authorization: {
          params: {
            hd: config.GOOGLE_WORKSPACE_DOMAIN,
            prompt: "select_account",
          },
        },
        checks: ["pkce", "state", "nonce"],
        clientId: config.AUTH_GOOGLE_ID,
        clientSecret: config.AUTH_GOOGLE_SECRET,
      }),
    ],
    secret: config.AUTH_SECRET,
    session: {
      maxAge: config.AUTH_SESSION_MAX_AGE_SECONDS,
      strategy: "jwt",
    },
    trustHost: true,
    useSecureCookies,
  };
}
