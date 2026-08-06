import {
  classifyInstagramResponse,
  instagramApiVersion,
  instagramCommentFields,
  instagramCommentPageSize,
  instagramGraphHost,
  parseInstagramRetryAfterMs,
  readInstagramCommentPage,
  summariseInstagramUsage,
  type InstagramCommentPage,
  type InstagramResponseClass,
  type InstagramUsageObservation,
} from "@studio-parallel/domain";

/**
 * HTTP plumbing for one post's comments edge.
 *
 * Every contract decision — which fields are requested, how a response is
 * classified, how a page is read — belongs to `@studio-parallel/domain`; this
 * module only performs the request and reduces the outcome to a safe shape.
 *
 * The access token travels as a bearer header, never as a query parameter, so
 * it cannot be captured from a URL in a proxy or access log. Provider bodies
 * never leave this module: failures carry a reason code and retry class only,
 * and here that matters more than anywhere else in the product — a comment body
 * is text a stranger wrote, and an error that echoed one would put it in a log
 * that no sanitiser downstream ever sees.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class InstagramCommentsError extends Error {
  readonly reasonCode: string;
  readonly responseClass: InstagramResponseClass;
  readonly retryAfterMs: number | null;

  constructor(
    responseClass: InstagramResponseClass,
    reasonCode: string,
    retryAfterMs: number | null = null,
  ) {
    super(`Instagram comments request failed: ${reasonCode}`);
    this.name = "InstagramCommentsError";
    this.reasonCode = reasonCode;
    this.responseClass = responseClass;
    this.retryAfterMs = retryAfterMs;
  }
}

export type InstagramCommentsFetch = Readonly<{
  page: InstagramCommentPage;
  usage: readonly InstagramUsageObservation[];
}>;

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

/**
 * Reads one page of comments for one post.
 *
 * The media id is validated before it reaches the path and the cursor before it
 * reaches the query, so a value that somehow arrived from the provider or the
 * database cannot redirect the request at another endpoint.
 */
export async function fetchInstagramCommentsPage(input: {
  accessToken: string;
  after?: string | null | undefined;
  fetchImplementation?: FetchLike | undefined;
  providerMediaId: string;
  timeoutMs?: number | undefined;
}): Promise<InstagramCommentsFetch> {
  const {
    accessToken,
    after = null,
    fetchImplementation = fetch,
    providerMediaId,
    timeoutMs = defaultTimeoutMs,
  } = input;

  if (!providerMediaIdPattern.test(providerMediaId)) {
    throw new InstagramCommentsError("invalid_request", "MEDIA_ID_INVALID");
  }
  if (after !== null && !cursorPattern.test(after)) {
    throw new InstagramCommentsError("invalid_request", "CURSOR_INVALID");
  }

  const url = new URL(
    `https://${instagramGraphHost}/${instagramApiVersion}/${providerMediaId}/comments`,
  );
  url.searchParams.set("fields", instagramCommentFields.join(","));
  url.searchParams.set("limit", String(instagramCommentPageSize));
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
    throw new InstagramCommentsError("transient", "COMMENTS_PAGE_UNREACHABLE");
  }

  const usage = summariseInstagramUsage((header) => response.headers.get(header));

  if (!response.ok) {
    const responseClass = classifyInstagramResponse({
      body: await readJsonBody(response),
      status: response.status,
    });
    throw new InstagramCommentsError(
      responseClass,
      "COMMENTS_PAGE_REJECTED",
      parseInstagramRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  const body = await readJsonBody(response);
  if (body === null) throw new InstagramCommentsError("transient", "COMMENTS_PAGE_NOT_JSON");

  const page = readInstagramCommentPage(body);

  // A page that claims a successor without a usable cursor cannot be resumed;
  // continuing would silently truncate the import.
  if (page.hasNextPage && !page.after) {
    throw new InstagramCommentsError("transient", "COMMENTS_PAGE_CURSOR_ABSENT");
  }

  return Object.freeze({ page, usage });
}
