import { classifyInstagramResponse } from "./instagram-media.js";

/**
 * Pure Instagram credential health and refresh contract.
 *
 * Health is derived from the expiry the provider actually returned and the
 * credential's own status, never from an assumption that a token is permanent.
 * A token with no recorded expiry is treated as unknown and probed, not as
 * healthy.
 *
 * Nothing here holds, receives or returns token material.
 */

/**
 * Meta documents refresh for the Instagram Login path at this unversioned
 * endpoint. Verified against the official reference on 2026-07-31:
 * https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token/
 */
export const instagramRefreshTokenUrl = "https://graph.instagram.com/refresh_access_token";
export const instagramTokenRefreshGrantType = "ig_refresh_token";

/**
 * Meta refuses to refresh a long-lived token younger than 24 hours. Attempting
 * it anyway would spend an attempt to be told something already known.
 */
export const instagramTokenRefreshMinimumAgeSeconds = 86_400;

/** Meta documents a refreshed token as valid for 60 days from the refresh. */
export const instagramTokenLifetimeDays = 60;

/**
 * Refresh with weeks of runway rather than days, so a run of transient provider
 * failures cannot strand a credential that could have been refreshed earlier.
 */
export const instagramTokenRefreshDueDays = 15;

/** Below this a human is needed before sync data silently goes stale. */
export const instagramTokenExpiryWarningDays = 5;

export const instagramTokenHealthStates = [
  "HEALTHY",
  "REFRESH_DUE",
  "EXPIRING",
  "EXPIRED",
  "EXPIRY_UNKNOWN",
  "REAUTHORISATION_REQUIRED",
  "REVOKED",
] as const;

export type InstagramTokenHealthState = (typeof instagramTokenHealthStates)[number];

export const instagramTokenFailures = [
  "PERMISSION_REVOKED",
  "REAUTHORISATION_REQUIRED",
  "TRANSIENT",
  "UNSUPPORTED",
] as const;

export type InstagramTokenFailure = (typeof instagramTokenFailures)[number];

export type InstagramTokenHealth = Readonly<{
  expiresInSeconds: number | null;
  /** True when Meta's documented refresh preconditions are satisfied. */
  refreshEligible: boolean;
  /** True when this credential should be refreshed now, if it is eligible. */
  refreshDue: boolean;
  state: InstagramTokenHealthState;
  tokenAgeSeconds: number;
}>;

const secondsPerDay = 86_400;

/** States in which a connection can no longer do provider work. */
const blockedStates = new Set<InstagramTokenHealthState>([
  "EXPIRED",
  "REAUTHORISATION_REQUIRED",
  "REVOKED",
]);

export function instagramConnectionBlocked(state: InstagramTokenHealthState): boolean {
  return blockedStates.has(state);
}

/**
 * Derives credential health.
 *
 * A null expiry is deliberately **not** treated as healthy: Meta's own
 * documentation says the response and token-debug results are authoritative, so
 * an unrecorded expiry means "probe it", not "it lasts forever".
 */
export function evaluateInstagramTokenHealth(
  input: Readonly<{
    credentialStatus: string;
    expiresAt: Date | null;
    issuedAt: Date;
    now: Date;
  }>,
): InstagramTokenHealth {
  const tokenAgeSeconds = Math.max(
    0,
    Math.floor((input.now.getTime() - input.issuedAt.getTime()) / 1000),
  );
  const oldEnoughToRefresh = tokenAgeSeconds >= instagramTokenRefreshMinimumAgeSeconds;

  if (input.credentialStatus === "REVOKED") {
    return frozenHealth({ expiresInSeconds: null, state: "REVOKED", tokenAgeSeconds });
  }
  if (input.credentialStatus === "REAUTHORISATION_REQUIRED") {
    return frozenHealth({
      expiresInSeconds: null,
      state: "REAUTHORISATION_REQUIRED",
      tokenAgeSeconds,
    });
  }

  if (!input.expiresAt) {
    return frozenHealth({
      expiresInSeconds: null,
      refreshDue: true,
      refreshEligible: oldEnoughToRefresh,
      state: "EXPIRY_UNKNOWN",
      tokenAgeSeconds,
    });
  }

  const expiresInSeconds = Math.floor((input.expiresAt.getTime() - input.now.getTime()) / 1000);

  // Meta will not refresh an expired token, so this needs a reconnect.
  if (expiresInSeconds <= 0) {
    return frozenHealth({ expiresInSeconds, state: "EXPIRED", tokenAgeSeconds });
  }

  const state: InstagramTokenHealthState =
    expiresInSeconds <= instagramTokenExpiryWarningDays * secondsPerDay
      ? "EXPIRING"
      : expiresInSeconds <= instagramTokenRefreshDueDays * secondsPerDay
        ? "REFRESH_DUE"
        : "HEALTHY";

  return frozenHealth({
    expiresInSeconds,
    refreshDue: state !== "HEALTHY",
    refreshEligible: oldEnoughToRefresh,
    state,
    tokenAgeSeconds,
  });
}

function frozenHealth(
  input: Readonly<{
    expiresInSeconds: number | null;
    refreshDue?: boolean;
    refreshEligible?: boolean;
    state: InstagramTokenHealthState;
    tokenAgeSeconds: number;
  }>,
): InstagramTokenHealth {
  return Object.freeze({
    expiresInSeconds: input.expiresInSeconds,
    refreshDue: input.refreshDue ?? false,
    refreshEligible: input.refreshEligible ?? false,
    state: input.state,
    tokenAgeSeconds: input.tokenAgeSeconds,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps a refresh or validation response to a credential outcome.
 *
 * A permission change is reported separately from an invalid token: both need a
 * reconnect, but an operator reading the audit trail should be able to tell a
 * withdrawn scope from an expired credential.
 */
export function classifyInstagramTokenResponse(
  input: Readonly<{ body: unknown; status: number }>,
): InstagramTokenFailure {
  const error = isRecord(input.body) && isRecord(input.body.error) ? input.body.error : null;
  const code = error && typeof error.code === "number" ? error.code : null;

  // 10 and the 200-299 block are Meta's permission-denied codes.
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return "PERMISSION_REVOKED";
  // 190 is an invalid or expired token; 102 is a lapsed session.
  if (code === 190 || code === 102) return "REAUTHORISATION_REQUIRED";

  switch (classifyInstagramResponse({ body: input.body, status: input.status })) {
    case "authorisation":
      return "REAUTHORISATION_REQUIRED";
    case "rate_limit":
    case "transient":
      return "TRANSIENT";
    default:
      // A rejected but well-formed refresh is not something retrying will fix,
      // and it is not evidence the token was revoked.
      return "UNSUPPORTED";
  }
}
