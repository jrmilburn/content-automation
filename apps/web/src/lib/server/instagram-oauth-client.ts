import "server-only";

import {
  instagramApiVersion,
  instagramGraphHost,
  instagramTokenUrl,
  resolveTokenExpiry,
} from "@studio-parallel/domain";

/**
 * Server-side Instagram Login token exchange and identity lookup.
 *
 * Access tokens are returned to the caller for immediate encryption and are
 * never logged, echoed into errors, or placed in a query string. Provider
 * response bodies never leave this module: failures are reduced to a safe error
 * class and reason code so no provider text, token or identifier can reach a
 * log, a client or an error monitor.
 */

export type InstagramProviderErrorClass = "authorisation" | "provider" | "rate_limit" | "transport";

export class InstagramProviderError extends Error {
  readonly errorClass: InstagramProviderErrorClass;
  readonly reasonCode: string;

  constructor(errorClass: InstagramProviderErrorClass, reasonCode: string) {
    super(`Instagram provider request failed: ${reasonCode}`);
    this.name = "InstagramProviderError";
    this.errorClass = errorClass;
    this.reasonCode = reasonCode;
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type InstagramTokenGrant = Readonly<{
  accessToken: string;
  expiresAt: Date | null;
  permissions: readonly string[];
  responseFields: readonly string[];
  tokenType: string;
}>;

export type InstagramIdentity = Readonly<{
  accountType: string;
  mediaCount: number | null;
  providerAccountId: string;
  username: string | null;
}>;

function classifyStatus(status: number): InstagramProviderErrorClass {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "authorisation";
  if (status >= 500) return "provider";
  return "provider";
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new InstagramProviderError("provider", "RESPONSE_NOT_JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InstagramProviderError("provider", "RESPONSE_NOT_OBJECT");
  }

  return parsed as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Exchanges a single-use authorisation code for a short-lived token. The code
 * and secret travel in a form body, never a URL, so neither can be captured
 * from a proxy or server access log.
 */
export async function exchangeInstagramAuthorizationCode(input: {
  appId: string;
  appSecret: string;
  code: string;
  fetchImplementation?: FetchLike | undefined;
  now?: Date | undefined;
  redirectUri: string;
}): Promise<InstagramTokenGrant> {
  const {
    appId,
    appSecret,
    code,
    fetchImplementation = fetch,
    now = new Date(),
    redirectUri,
  } = input;

  // Meta appends a `#_=_` fragment to the redirect that browsers retain; it is
  // not part of the code and makes an otherwise valid exchange fail.
  const normalisedCode = code.split("#")[0]?.trim() ?? "";
  if (!normalisedCode) {
    throw new InstagramProviderError("authorisation", "CODE_MISSING");
  }

  const body = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    code: normalisedCode,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  let response: Response;
  try {
    response = await fetchImplementation(instagramTokenUrl, {
      body,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
  } catch {
    throw new InstagramProviderError("transport", "CODE_EXCHANGE_UNREACHABLE");
  }

  if (!response.ok) {
    throw new InstagramProviderError(classifyStatus(response.status), "CODE_EXCHANGE_REJECTED");
  }

  const record = await readJsonRecord(response);
  const accessToken = readString(record, "access_token");
  if (!accessToken) {
    throw new InstagramProviderError("provider", "CODE_EXCHANGE_TOKEN_ABSENT");
  }

  const permissions = record.permissions;
  return Object.freeze({
    accessToken,
    // The short-lived response carries no expiry; the long-lived exchange does.
    expiresAt: resolveTokenExpiry(
      typeof record.expires_in === "number" ? record.expires_in : null,
      now,
    ),
    permissions: Object.freeze(
      Array.isArray(permissions)
        ? permissions.filter((scope): scope is string => typeof scope === "string")
        : typeof permissions === "string"
          ? permissions
              .split(",")
              .map((scope) => scope.trim())
              .filter(Boolean)
          : [],
    ),
    responseFields: Object.freeze(Object.keys(record).sort()),
    tokenType: readString(record, "token_type") ?? "bearer",
  });
}

/**
 * Upgrades a short-lived token to the sixty-day long-lived form. Meta documents
 * this endpoint without a version prefix and requires the app secret, so it is
 * server-only.
 */
export async function exchangeForLongLivedInstagramToken(input: {
  appSecret: string;
  fetchImplementation?: FetchLike | undefined;
  now?: Date | undefined;
  shortLivedToken: string;
}): Promise<InstagramTokenGrant> {
  const { appSecret, fetchImplementation = fetch, now = new Date(), shortLivedToken } = input;

  const url = new URL(`https://${instagramGraphHost}/access_token`);
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortLivedToken);

  let response: Response;
  try {
    response = await fetchImplementation(url, { method: "GET" });
  } catch {
    throw new InstagramProviderError("transport", "TOKEN_UPGRADE_UNREACHABLE");
  }

  if (!response.ok) {
    throw new InstagramProviderError(classifyStatus(response.status), "TOKEN_UPGRADE_REJECTED");
  }

  const record = await readJsonRecord(response);
  const accessToken = readString(record, "access_token");
  if (!accessToken) {
    throw new InstagramProviderError("provider", "TOKEN_UPGRADE_TOKEN_ABSENT");
  }

  return Object.freeze({
    accessToken,
    expiresAt: resolveTokenExpiry(
      typeof record.expires_in === "number" ? record.expires_in : null,
      now,
    ),
    permissions: Object.freeze([]),
    responseFields: Object.freeze(Object.keys(record).sort()),
    tokenType: readString(record, "token_type") ?? "bearer",
  });
}

/**
 * Asks the provider to drop the granted permissions for an account.
 *
 * Disconnect must not depend on this succeeding: the local purge is what
 * actually stops this product using the token, and a provider outage cannot be
 * allowed to strand a credential the operator asked us to destroy. The caller
 * therefore records the outcome and continues either way, so this returns a
 * boolean rather than throwing.
 */
export async function revokeInstagramAccess(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
  providerAccountId: string;
}): Promise<boolean> {
  const { accessToken, fetchImplementation = fetch, providerAccountId } = input;

  const url = new URL(
    `https://${instagramGraphHost}/${instagramApiVersion}/${encodeURIComponent(providerAccountId)}/permissions`,
  );

  try {
    const response = await fetchImplementation(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: "DELETE",
    });

    // An already-revoked or already-expired grant answers 400/401 rather than
    // 200. That is the desired end state, not a failure to report, but it is
    // not distinguishable from a genuine refusal without parsing provider text
    // this module deliberately never surfaces. Treat only 2xx as confirmed.
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Reads the authorised account identity. The token is sent as a bearer header
 * rather than a query parameter so it cannot be captured from a URL.
 */
export async function fetchInstagramIdentity(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
}): Promise<InstagramIdentity> {
  const { accessToken, fetchImplementation = fetch } = input;

  const url = new URL(`https://${instagramGraphHost}/${instagramApiVersion}/me`);
  url.searchParams.set("fields", "id,account_type,media_count,username");

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      method: "GET",
    });
  } catch {
    throw new InstagramProviderError("transport", "IDENTITY_UNREACHABLE");
  }

  if (!response.ok) {
    throw new InstagramProviderError(classifyStatus(response.status), "IDENTITY_REJECTED");
  }

  const record = await readJsonRecord(response);
  const providerAccountId = readString(record, "id");
  const accountType = readString(record, "account_type");

  if (!providerAccountId || !accountType) {
    throw new InstagramProviderError("provider", "IDENTITY_INCOMPLETE");
  }

  return Object.freeze({
    accountType,
    mediaCount: typeof record.media_count === "number" ? record.media_count : null,
    providerAccountId,
    username: readString(record, "username"),
  });
}
