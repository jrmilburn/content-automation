import {
  classifyInstagramTokenResponse,
  instagramApiVersion,
  instagramGraphHost,
  instagramRefreshTokenUrl,
  instagramTokenRefreshGrantType,
  resolveTokenExpiry,
  type InstagramTokenFailure,
} from "@studio-parallel/domain";

/**
 * HTTP plumbing for Instagram credential refresh and validation.
 *
 * Token material passes through as a local and is never logged, echoed into an
 * error, or returned alongside provider text. Failures reduce to a classified
 * outcome and a stable reason code.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class InstagramTokenError extends Error {
  readonly failure: InstagramTokenFailure;
  readonly reasonCode: string;

  constructor(failure: InstagramTokenFailure, reasonCode: string) {
    super(`Instagram token request failed: ${reasonCode}`);
    this.name = "InstagramTokenError";
    this.failure = failure;
    this.reasonCode = reasonCode;
  }
}

export type InstagramRefreshedToken = Readonly<{
  accessToken: string;
  expiresAt: Date | null;
  tokenType: string;
}>;

const defaultTimeoutMs = 15_000;

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Refreshes a long-lived token for a further sixty days.
 *
 * Meta documents this endpoint as unversioned and requires the token as a query
 * parameter — it does not accept a bearer header — so this is the one call in
 * the integration where a credential appears in a URL. The URL is built here and
 * never logged, and `redirect: "error"` prevents it being replayed to another
 * host.
 *
 * The caller must confirm eligibility first: Meta rejects a token younger than
 * twenty-four hours or already expired.
 */
export async function refreshInstagramToken(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
  now?: Date | undefined;
  timeoutMs?: number | undefined;
}): Promise<InstagramRefreshedToken> {
  const {
    accessToken,
    fetchImplementation = fetch,
    now = new Date(),
    timeoutMs = defaultTimeoutMs,
  } = input;

  if (accessToken.length === 0) {
    throw new InstagramTokenError("REAUTHORISATION_REQUIRED", "TOKEN_ABSENT");
  }

  const url = new URL(instagramRefreshTokenUrl);
  url.searchParams.set("grant_type", instagramTokenRefreshGrantType);
  url.searchParams.set("access_token", accessToken);

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: { Accept: "application/json", "User-Agent": "StudioParallelInstagramSync/1.0" },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramTokenError("TRANSIENT", "REFRESH_UNREACHABLE");
  }

  if (!response.ok) {
    throw new InstagramTokenError(
      classifyInstagramTokenResponse({
        body: await readJsonBody(response),
        status: response.status,
      }),
      "REFRESH_REJECTED",
    );
  }

  const body = await readJsonBody(response);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InstagramTokenError("TRANSIENT", "REFRESH_NOT_JSON");
  }

  const record = body as Record<string, unknown>;
  const refreshed = readString(record, "access_token");
  if (!refreshed) {
    throw new InstagramTokenError("UNSUPPORTED", "REFRESH_TOKEN_ABSENT");
  }

  return Object.freeze({
    accessToken: refreshed,
    // The provider's own expiry is authoritative; sixty days is never assumed.
    expiresAt: resolveTokenExpiry(
      typeof record.expires_in === "number" ? record.expires_in : null,
      now,
    ),
    tokenType: readString(record, "token_type") ?? "bearer",
  });
}

/**
 * Probes whether a credential still works, for tokens not yet old enough to
 * refresh. The token is sent as a bearer header because this endpoint accepts
 * one, so it never reaches a URL.
 */
export async function validateInstagramToken(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
  timeoutMs?: number | undefined;
}): Promise<void> {
  const { accessToken, fetchImplementation = fetch, timeoutMs = defaultTimeoutMs } = input;

  if (accessToken.length === 0) {
    throw new InstagramTokenError("REAUTHORISATION_REQUIRED", "TOKEN_ABSENT");
  }

  const url = new URL(`https://${instagramGraphHost}/${instagramApiVersion}/me`);
  url.searchParams.set("fields", "id");

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "StudioParallelInstagramSync/1.0",
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramTokenError("TRANSIENT", "VALIDATE_UNREACHABLE");
  }

  if (!response.ok) {
    throw new InstagramTokenError(
      classifyInstagramTokenResponse({
        body: await readJsonBody(response),
        status: response.status,
      }),
      "VALIDATE_REJECTED",
    );
  }
}
