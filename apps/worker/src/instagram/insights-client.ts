import {
  classifyInstagramResponse,
  instagramApiVersion,
  instagramGraphHost,
  parseInstagramRetryAfterMs,
  summariseInstagramUsage,
  type InstagramInsightGroup,
  type InstagramResponseClass,
  type InstagramUsageObservation,
} from "@studio-parallel/domain";

/**
 * Graph insights transport for one media item.
 *
 * One request per metric group, never one large request: Meta rejects an
 * unsupported metric name with error code 100 and discards the whole response,
 * so grouping is what stops a single withdrawn field costing every metric
 * beside it. The caller decides what a failed group means; this module only
 * reports which group failed and how.
 *
 * Provider bodies never leave here. A failure surfaces as a response class and
 * a safe reason code, so no provider text can reach a log or a database.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const providerMediaIdPattern = /^[0-9]{5,32}$/u;
const defaultTimeoutMs = 15_000;

export class InstagramInsightsError extends Error {
  readonly groupKey: string;
  readonly reasonCode: string;
  readonly responseClass: InstagramResponseClass;
  readonly retryAfterMs: number | null;

  constructor(
    groupKey: string,
    responseClass: InstagramResponseClass,
    reasonCode: string,
    retryAfterMs: number | null = null,
  ) {
    super(`Instagram insights request failed: ${reasonCode}`);
    this.name = "InstagramInsightsError";
    this.groupKey = groupKey;
    this.reasonCode = reasonCode;
    this.responseClass = responseClass;
    this.retryAfterMs = retryAfterMs;
  }
}

export type InstagramInsightGroupFetch = Readonly<{
  body: unknown;
  usage: readonly InstagramUsageObservation[];
}>;

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Fetches one metric group for one media item.
 *
 * Usage headers are summarised before the ok check so a throttled response
 * still reports what it cost.
 */
export async function fetchInstagramInsightGroup(input: {
  accessToken: string;
  fetchImplementation?: FetchLike | undefined;
  group: InstagramInsightGroup;
  providerMediaId: string;
  timeoutMs?: number | undefined;
}): Promise<InstagramInsightGroupFetch> {
  const {
    accessToken,
    fetchImplementation = fetch,
    group,
    providerMediaId,
    timeoutMs = defaultTimeoutMs,
  } = input;

  if (!providerMediaIdPattern.test(providerMediaId)) {
    throw new InstagramInsightsError(group.key, "invalid_request", "MEDIA_ID_INVALID");
  }
  if (group.metrics.length === 0) {
    throw new InstagramInsightsError(group.key, "invalid_request", "METRIC_GROUP_EMPTY");
  }

  const url = new URL(
    `https://${instagramGraphHost}/${instagramApiVersion}/${providerMediaId}/insights`,
  );
  url.searchParams.set("metric", group.metrics.map((metric) => metric.provider).join(","));

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        // The token travels as a header, never a query parameter, so it cannot
        // be captured from a proxy or server access log.
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "StudioParallelInstagramSync/1.0",
      },
      method: "GET",
      // A redirect off the pinned Graph host would send the bearer token
      // somewhere unaudited.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramInsightsError(group.key, "transient", "INSIGHTS_UNREACHABLE");
  }

  const usage = summariseInstagramUsage((header) => response.headers.get(header));

  if (!response.ok) {
    const responseClass = classifyInstagramResponse({
      body: await readJsonBody(response),
      status: response.status,
    });
    throw new InstagramInsightsError(
      group.key,
      responseClass,
      "INSIGHTS_REJECTED",
      parseInstagramRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  const body = await readJsonBody(response);
  if (body === null) {
    throw new InstagramInsightsError(group.key, "transient", "INSIGHTS_NOT_JSON");
  }

  return Object.freeze({ body, usage });
}
