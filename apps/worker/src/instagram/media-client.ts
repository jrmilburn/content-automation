import {
  classifyInstagramResponse,
  instagramApiVersion,
  instagramGraphHost,
  instagramMediaFields,
  instagramMediaImportFields,
  instagramMediaPageSize,
  parseInstagramRetryAfterMs,
  readInstagramMediaPage,
  summariseInstagramUsage,
  type InstagramMediaPage,
  type InstagramResponseClass,
  type InstagramUsageObservation,
} from "@studio-parallel/domain";

/**
 * HTTP plumbing for the authorised account's owned-media edge.
 *
 * Every contract decision — which fields are requested, how a response is
 * classified, how a page is read — belongs to `@studio-parallel/domain`; this
 * module only performs the request and reduces the outcome to a safe shape.
 *
 * The access token travels as a bearer header, never as a query parameter, so
 * it cannot be captured from a URL in a proxy or access log. Provider bodies
 * never leave this module: failures carry a reason code and retry class only.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class InstagramMediaError extends Error {
  readonly reasonCode: string;
  readonly responseClass: InstagramResponseClass;
  readonly retryAfterMs: number | null;

  constructor(
    responseClass: InstagramResponseClass,
    reasonCode: string,
    retryAfterMs: number | null = null,
  ) {
    super(`Instagram media request failed: ${reasonCode}`);
    this.name = "InstagramMediaError";
    this.reasonCode = reasonCode;
    this.responseClass = responseClass;
    this.retryAfterMs = retryAfterMs;
  }
}

export type InstagramMediaFetch = Readonly<{
  page: InstagramMediaPage;
  usage: readonly InstagramUsageObservation[];
}>;

const providerAccountIdPattern = /^[0-9]{5,32}$/u;
const providerMediaIdPattern = /^[0-9]{5,32}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,512}$/u;
const defaultTimeoutMs = 15_000;

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export type InstagramMediaItemFetch = Readonly<{
  mediaProductType: string | null;
  mediaType: string | null;
  /**
   * The signed CDN URL, freshly issued for this request.
   *
   * It is returned rather than stored because Meta re-signs it every time it is
   * asked: a value kept for later is a URL that starts refusing, and the
   * refusal looks like a provider fault rather than the expiry it is.
   */
  mediaUrl: string | null;
  usage: readonly InstagramUsageObservation[];
}>;

/**
 * Reads one media node, for the fresh `media_url` an import needs.
 *
 * Only fields the pinned media contract already documents are requested, so
 * this adds an endpoint without changing the field set the sanitised proof
 * covers. The media id is validated before it reaches the path, for the same
 * reason the account id is on the edge below: a value that arrived from the
 * database must not be able to redirect the request at another endpoint.
 */
export async function fetchInstagramMediaItem(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
  providerMediaId: string;
  timeoutMs?: number | undefined;
}): Promise<InstagramMediaItemFetch> {
  const {
    accessToken,
    fetchImplementation = fetch,
    providerMediaId,
    timeoutMs = defaultTimeoutMs,
  } = input;

  if (!providerMediaIdPattern.test(providerMediaId)) {
    throw new InstagramMediaError("invalid_request", "MEDIA_ID_INVALID");
  }

  const url = new URL(`https://${instagramGraphHost}/${instagramApiVersion}/${providerMediaId}`);
  url.searchParams.set("fields", instagramMediaImportFields.join(","));

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
    throw new InstagramMediaError("transient", "MEDIA_ITEM_UNREACHABLE");
  }

  const usage = summariseInstagramUsage((header) => response.headers.get(header));

  if (!response.ok) {
    const responseClass = classifyInstagramResponse({
      body: await readJsonBody(response),
      status: response.status,
    });
    throw new InstagramMediaError(
      responseClass,
      "MEDIA_ITEM_REJECTED",
      parseInstagramRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  const body = await readJsonBody(response);
  if (body === null || typeof body !== "object") {
    throw new InstagramMediaError("transient", "MEDIA_ITEM_NOT_JSON");
  }

  const item = body as Record<string, unknown>;

  return Object.freeze({
    mediaProductType: readOptionalString(item, "media_product_type"),
    mediaType: readOptionalString(item, "media_type"),
    mediaUrl: readOptionalString(item, "media_url"),
    usage,
  });
}

function readOptionalString(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Reads one page of owned media.
 *
 * The account id is validated before it reaches the path and the cursor before
 * it reaches the query, so a value that somehow arrived from the provider or
 * the database cannot redirect the request at another endpoint.
 */
export async function fetchInstagramMediaPage(input: {
  accessToken: string;
  after?: string | null | undefined;
  fetchImplementation?: FetchLike | undefined;
  providerAccountId: string;
  timeoutMs?: number | undefined;
}): Promise<InstagramMediaFetch> {
  const {
    accessToken,
    after = null,
    fetchImplementation = fetch,
    providerAccountId,
    timeoutMs = defaultTimeoutMs,
  } = input;

  if (!providerAccountIdPattern.test(providerAccountId)) {
    throw new InstagramMediaError("invalid_request", "ACCOUNT_ID_INVALID");
  }
  if (after !== null && !cursorPattern.test(after)) {
    throw new InstagramMediaError("invalid_request", "CURSOR_INVALID");
  }

  const url = new URL(
    `https://${instagramGraphHost}/${instagramApiVersion}/${providerAccountId}/media`,
  );
  url.searchParams.set("fields", instagramMediaFields.join(","));
  url.searchParams.set("limit", String(instagramMediaPageSize));
  if (after) url.searchParams.set("after", after);

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "StudioParallelInstagramSync/1.0",
      },
      method: "GET",
      // A redirect off the pinned Graph host would send the bearer token
      // somewhere unaudited, so it is an error rather than something to follow.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramMediaError("transient", "MEDIA_PAGE_UNREACHABLE");
  }

  const usage = summariseInstagramUsage((header) => response.headers.get(header));

  if (!response.ok) {
    const responseClass = classifyInstagramResponse({
      body: await readJsonBody(response),
      status: response.status,
    });
    throw new InstagramMediaError(
      responseClass,
      "MEDIA_PAGE_REJECTED",
      parseInstagramRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  const body = await readJsonBody(response);
  if (body === null) throw new InstagramMediaError("transient", "MEDIA_PAGE_NOT_JSON");

  const page = readInstagramMediaPage(body);

  // A page that claims a successor without a usable cursor cannot be resumed;
  // continuing would silently truncate the import.
  if (page.hasNextPage && !page.after) {
    throw new InstagramMediaError("transient", "MEDIA_PAGE_CURSOR_ABSENT");
  }

  return Object.freeze({ page, usage });
}
