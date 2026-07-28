import type { AuthConfig } from "@studio-parallel/config";
import type { SessionPrincipal, SignInDecision } from "@studio-parallel/db";
import type { ErrorMonitor, JsonLogEvent } from "@studio-parallel/observability";
import { createCorrelationId, createJsonLogger } from "@studio-parallel/observability";
import { describe, expect, it, vi } from "vitest";

import { createAuthOptions } from "./auth-options";

const internalUserId = "01900000-0000-7000-8000-000000000021";
const workspaceId = "01900000-0000-7000-8000-000000000001";
const correlationId = createCorrelationId(() => "019873d5-31e6-7c59-a531-1f2f4cbce121");

function createFixture(environment: AuthConfig["APP_ENV"] = "production") {
  const events: JsonLogEvent[] = [];
  const now = new Date("2026-07-28T00:00:00.000Z");
  const authoriseIdentity = vi.fn<
    (
      identity: Readonly<{ displayName?: string; email: string; subject: string }>,
    ) => Promise<SignInDecision>
  >(() =>
    Promise.resolve({
      allowed: true,
      principal: { internalUserId, sessionVersion: 1, workspaceId },
    }),
  );
  const config: AuthConfig = {
    APP_ENV: environment,
    AUTH_GOOGLE_ID: "google-client-id",
    AUTH_GOOGLE_SECRET: "google-client-secret",
    AUTH_SECRET: "test-auth-secret-that-is-long-enough-000000",
    AUTH_SESSION_MAX_AGE_SECONDS: 28_800,
    GOOGLE_WORKSPACE_DOMAIN: "studio.example",
    PUBLIC_ORIGIN:
      environment === "local" ? "http://localhost:3000" : "https://content.studio.example",
  };
  const logger = createJsonLogger({
    environment,
    release: "test-release",
    service: "web",
    sink: (event) => events.push(event),
  });
  const monitor: ErrorMonitor = { captureException: () => undefined };
  const validateSessionPrincipal = vi.fn(
    (principal: SessionPrincipal): Promise<SessionPrincipal | null> => Promise.resolve(principal),
  );
  const options = createAuthOptions(config, {
    authoriseIdentity,
    createCorrelationId: () => correlationId,
    logger,
    monitor,
    now: () => now,
    validateSessionPrincipal,
  });

  return { authoriseIdentity, config, events, now, options, validateSessionPrincipal };
}

describe("Auth.js contract", () => {
  it("pins Google OIDC issuer checks and hardened bounded production cookies", () => {
    const { options } = createFixture();
    const provider = options.providers[0];

    expect(provider).toMatchObject({
      id: "google",
      issuer: "https://accounts.google.com",
      type: "oidc",
      options: {
        checks: ["pkce", "state", "nonce"],
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      },
    });
    expect(options.session).toMatchObject({
      maxAge: 28_800,
      strategy: "jwt",
    });
    expect(options.cookies?.sessionToken).toEqual({
      name: "__Secure-authjs.session-token",
      options: {
        httpOnly: true,
        maxAge: 28_800,
        path: "/",
        sameSite: "lax",
        secure: true,
      },
    });

    const local = createFixture("local").options;
    expect(local.cookies?.sessionToken?.options?.secure).toBe(false);
    expect(local.cookies?.sessionToken?.name).toBe("authjs.session-token");
  });

  it("issues a minimal principal-only session for an approved allowlisted identity", async () => {
    const { authoriseIdentity, events, now, options } = createFixture();
    const user: Record<string, unknown> = {};
    const signIn = options.callbacks?.signIn as unknown as (input: {
      account: { provider: string };
      profile: Record<string, unknown>;
      user: Record<string, unknown>;
    }) => Promise<boolean>;
    const jwt = options.callbacks?.jwt as unknown as (input: {
      token: Record<string, unknown>;
      user: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;
    const session = options.callbacks?.session as unknown as (input: {
      session: { expires: string; user: Record<string, unknown> };
      token: Record<string, unknown>;
    }) => Promise<Record<string, unknown>>;

    await expect(
      signIn({
        account: { provider: "google" },
        profile: {
          email: "Approved@Studio.Example",
          email_verified: true,
          hd: "studio.example",
          name: "Approved Teammate",
          sub: "google-subject-21",
        },
        user,
      }),
    ).resolves.toBe(true);

    expect(authoriseIdentity).toHaveBeenCalledWith(
      {
        displayName: "Approved Teammate",
        email: "approved@studio.example",
        subject: "google-subject-21",
      },
      correlationId,
    );
    expect(user).toMatchObject({ internalUserId, sessionVersion: 1, workspaceId });

    const token = await jwt({ token: {}, user });
    expect(token).toEqual({
      internalUserId,
      sessionStartedAt: now.getTime() / 1000,
      sessionVersion: 1,
      sub: internalUserId,
      workspaceId,
    });
    await expect(
      Promise.resolve(
        session({
          session: { expires: "2026-07-28T10:00:00.000Z", user: {} },
          token: token ?? {},
        }),
      ),
    ).resolves.toEqual({
      expires: "2026-07-28T10:00:00.000Z",
      user: { id: internalUserId, internalUserId, sessionVersion: 1, workspaceId },
    });
    expect(JSON.stringify(token)).not.toMatch(/email|name|access|id_token/iu);
    expect(events).toEqual([
      expect.objectContaining({
        actorId: internalUserId,
        event: "auth.sign_in.succeeded",
        workspaceId,
      }),
    ]);
  });

  it("rejects expired and administratively invalidated session claims", async () => {
    const { now, options, validateSessionPrincipal } = createFixture();
    const jwt = options.callbacks?.jwt as unknown as (input: {
      token: Record<string, unknown>;
    }) => Promise<Record<string, unknown> | null>;
    const principal = { internalUserId, sessionVersion: 1, workspaceId };

    await expect(
      jwt({
        token: {
          ...principal,
          sessionStartedAt: now.getTime() / 1000 - 28_800,
        },
      }),
    ).resolves.toBeNull();
    expect(validateSessionPrincipal).not.toHaveBeenCalled();

    validateSessionPrincipal.mockResolvedValueOnce(null);
    await expect(
      jwt({
        token: {
          ...principal,
          sessionStartedAt: now.getTime() / 1000 - 60,
        },
      }),
    ).resolves.toBeNull();
    expect(validateSessionPrincipal).toHaveBeenCalledWith(principal);
  });

  it("denies malformed, wrong-domain and unlisted identities through one outward result", async () => {
    const fixture = createFixture();
    const signIn = fixture.options.callbacks?.signIn as unknown as (input: {
      account: { provider: string };
      profile: Record<string, unknown>;
      user: Record<string, unknown>;
    }) => Promise<boolean>;

    await expect(
      signIn({
        account: { provider: "google" },
        profile: {
          email: "outsider@outside.example",
          email_verified: true,
          hd: "outside.example",
          sub: "outside-subject",
        },
        user: {},
      }),
    ).resolves.toBe(false);
    expect(fixture.authoriseIdentity).not.toHaveBeenCalled();

    fixture.authoriseIdentity.mockResolvedValueOnce({
      allowed: false,
      reason: "UNLISTED_IDENTITY",
    });
    await expect(
      signIn({
        account: { provider: "google" },
        profile: {
          email: "unlisted@studio.example",
          email_verified: true,
          hd: "studio.example",
          sub: "unlisted-subject",
        },
        user: {},
      }),
    ).resolves.toBe(false);

    expect(fixture.events.map(({ event }) => event)).toEqual([
      "auth.sign_in.denied",
      "auth.sign_in.denied",
    ]);
  });

  it("rejects crafted off-site return URLs", async () => {
    const { options } = createFixture();
    const redirect = options.callbacks?.redirect as (input: {
      baseUrl: string;
      url: string;
    }) => Promise<string> | string;

    await expect(
      Promise.resolve(
        redirect({
          baseUrl: "https://content.studio.example",
          url: "https://outside.example/steal",
        }),
      ),
    ).resolves.toBe("https://content.studio.example");
  });
});
