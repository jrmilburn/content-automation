import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Pure Instagram Business Login contract and connection-state logic.
 *
 * This module is the canonical source for the pinned provider contract. The
 * `scripts/meta-contract` proof harness pins the same values; if either changes,
 * the sanitised contract proof must be rerun before dependent work continues.
 *
 * Everything here is deterministic given its inputs so the security decisions
 * can be tested exhaustively. No network, storage, cookie or logging concern
 * belongs in this file.
 */

export const instagramApiVersion = "v25.0";
export const instagramGraphHost = "graph.instagram.com";
export const instagramAuthorizeUrl = "https://www.instagram.com/oauth/authorize";
export const instagramTokenUrl = "https://api.instagram.com/oauth/access_token";

/** Least-privilege read-only scopes. Publishing/messaging are never requested. */
export const instagramRequiredScopes = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
] as const;

export const instagramEligibleAccountTypes = ["BUSINESS", "CREATOR"] as const;

export type InstagramAccountType = (typeof instagramEligibleAccountTypes)[number];

/**
 * Meta's Business Login documentation does not describe PKCE support for the
 * Instagram Login path, so no code challenge is sent: advertising a challenge
 * the provider ignores would imply a protection that is not in force. The
 * single-use, session-bound, short-lived `state` below is the CSRF control.
 * Revisit only against official documentation, never by assumption.
 */
export const instagramPkceSupported = false;

export const instagramStateByteLength = 32;
export const instagramStateLifetimeSeconds = 600;

export const instagramConnectionDenialReasons = [
  "STATE_MISSING",
  "STATE_MISMATCH",
  "STATE_EXPIRED",
  "STATE_ALREADY_USED",
  "CONSENT_CANCELLED",
  "PROVIDER_ERROR",
  "CODE_MISSING",
  "ACCOUNT_TYPE_INELIGIBLE",
  "SCOPE_DOWNGRADED",
  "REDIRECT_URI_INVALID",
] as const;

export type InstagramConnectionDenialReason = (typeof instagramConnectionDenialReasons)[number];

export type InstagramAuthorizationRequest = Readonly<{
  authorizeUrl: string;
  expiresAt: Date;
  redirectUri: string;
  state: string;
}>;

export type InstagramStateRecord = Readonly<{
  expiresAt: Date;
  consumed: boolean;
  state: string;
}>;

export type InstagramCallbackDecision =
  | Readonly<{ allowed: true; code: string }>
  | Readonly<{ allowed: false; reason: InstagramConnectionDenialReason }>;

/** Exact allowlisted HTTPS callback. Wildcards and loopback are never accepted. */
export function buildInstagramRedirectUri(publicOrigin: string): string {
  const origin = new URL(publicOrigin);

  if (origin.protocol !== "https:") {
    throw new Error("Instagram redirect URI must use HTTPS");
  }
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    throw new Error("Instagram redirect URI origin must not carry a path or credentials");
  }

  return `${origin.origin}/api/integrations/instagram/callback`;
}

export function isValidInstagramRedirectUri(candidate: string, publicOrigin: string): boolean {
  try {
    return candidate === buildInstagramRedirectUri(publicOrigin);
  } catch {
    return false;
  }
}

export function createInstagramAuthorizationRequest(input: {
  appId: string;
  now?: Date;
  publicOrigin: string;
  randomSource?: (size: number) => Buffer;
}): InstagramAuthorizationRequest {
  const { appId, now = new Date(), publicOrigin, randomSource = randomBytes } = input;
  const redirectUri = buildInstagramRedirectUri(publicOrigin);

  // base64url so the value survives a cookie and a query string unchanged.
  const state = randomSource(instagramStateByteLength).toString("base64url");

  const authorizeUrl = new URL(instagramAuthorizeUrl);
  authorizeUrl.searchParams.set("client_id", appId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", instagramRequiredScopes.join(","));
  authorizeUrl.searchParams.set("state", state);

  return Object.freeze({
    authorizeUrl: authorizeUrl.toString(),
    expiresAt: new Date(now.getTime() + instagramStateLifetimeSeconds * 1000),
    redirectUri,
    state,
  });
}

function statesMatch(left: string, right: string): boolean {
  // Compare digests so differing lengths cannot throw or leak via timing.
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * Decides whether a callback may proceed to code exchange. Ordering matters:
 * state is validated before any provider-supplied value is trusted, and a
 * cancelled consent is reported distinctly from a provider error so operators
 * can tell a human decision from a fault.
 */
export function evaluateInstagramCallback(input: {
  code?: string | null;
  now?: Date;
  providerError?: string | null;
  receivedState?: string | null;
  storedState?: InstagramStateRecord | null;
}): InstagramCallbackDecision {
  const { code, now = new Date(), providerError, receivedState, storedState } = input;

  if (!storedState || !receivedState) {
    return { allowed: false, reason: "STATE_MISSING" };
  }
  if (!statesMatch(storedState.state, receivedState)) {
    return { allowed: false, reason: "STATE_MISMATCH" };
  }
  if (storedState.consumed) {
    return { allowed: false, reason: "STATE_ALREADY_USED" };
  }
  if (storedState.expiresAt.getTime() <= now.getTime()) {
    return { allowed: false, reason: "STATE_EXPIRED" };
  }

  if (providerError) {
    return {
      allowed: false,
      reason: providerError === "access_denied" ? "CONSENT_CANCELLED" : "PROVIDER_ERROR",
    };
  }
  if (!code) {
    return { allowed: false, reason: "CODE_MISSING" };
  }

  return { allowed: true, code };
}

export function isEligibleInstagramAccountType(
  candidate: string,
): candidate is InstagramAccountType {
  return (instagramEligibleAccountTypes as readonly string[]).includes(candidate);
}

/**
 * A grant is acceptable only if every required scope is present. Extra scopes
 * are reported so an over-broad grant is visible rather than silently accepted.
 */
export function evaluateInstagramGrantedScopes(granted: readonly string[]): Readonly<{
  extra: readonly string[];
  missing: readonly string[];
  satisfied: boolean;
}> {
  const normalised = new Set(granted.map((scope) => scope.trim()).filter(Boolean));
  const missing = instagramRequiredScopes.filter((scope) => !normalised.has(scope));
  const extra = [...normalised]
    .filter((scope) => !(instagramRequiredScopes as readonly string[]).includes(scope))
    .sort();

  return Object.freeze({ extra, missing, satisfied: missing.length === 0 });
}

/** Meta returns a duration; the absolute instant is what gets persisted. */
export function resolveTokenExpiry(
  expiresInSeconds: number | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) return null;
  if (expiresInSeconds <= 0) return null;
  return new Date(now.getTime() + Math.floor(expiresInSeconds) * 1000);
}
