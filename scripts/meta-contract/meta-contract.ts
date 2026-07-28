import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const META_CONTRACT = Object.freeze({
  schemaVersion: 1,
  apiVersion: "v25.0",
  graphHost: "graph.instagram.com",
  loginPath: "instagram_login",
  accessLevel: "standard",
  requiredScopes: ["instagram_business_basic", "instagram_business_manage_insights"] as const,
  accountFields: ["id", "account_type", "media_count"] as const,
  mediaFields: ["id", "media_type", "media_product_type", "timestamp"] as const,
  insightGroups: {
    distribution: ["views", "reach"],
    engagement: ["likes", "comments", "shares", "saved", "total_interactions"],
    watchTime: ["ig_reels_video_view_total_time", "ig_reels_avg_watch_time"],
  } as const,
  usageHeaders: ["x-app-usage", "x-business-use-case-usage"] as const,
  versionHeaders: ["instagram-api-version", "facebook-api-version"] as const,
  invalidMetricProbe: "studio_parallel_contract_probe",
  mediaPageSize: 2,
  maximumMediaPages: 25,
});

const evidenceLabels = ["recent", "older", "missing-data"] as const;
const safeTokenFieldName = /^[a-z][a-z0-9_]{0,63}$/u;
const providerId = /^\d{5,30}$/u;

export type MetaContractConfiguration = Readonly<{
  accessLevel: "standard";
  accessToken: string;
  accountOwnership: "owned" | "managed";
  grantedScopes: readonly string[];
  outputPath: string;
  redirectUri: string;
  selectedMediaIds: readonly [string, string, string];
  tokenExpiresInSeconds: number | null;
  tokenResponseFields: readonly string[];
}>;

type SafeUsageObservation = Readonly<{
  header: (typeof META_CONTRACT.usageHeaders)[number];
  maximumPercentage: number | null;
}>;

type SafeInsightCase = Readonly<{
  availableMetricCount: number;
  errorClass: "none" | "permission" | "provider" | "rate_limit" | "unsupported";
  label: (typeof evidenceLabels)[number];
  metricGroupsAttempted: number;
  productType: string;
  unavailableMetricCount: number;
}>;

type SafeCheck = Readonly<{ name: string; passed: boolean }>;

export type SanitizedMetaContractProof = Readonly<{
  schemaVersion: number;
  kind: "sanitized-meta-contract-proof";
  observedAt: string;
  status: "failed" | "passed";
  contract: Readonly<{
    accessLevel: "standard";
    apiVersion: string;
    graphHost: string;
    insightGroups: Readonly<Record<string, readonly string[]>>;
    loginPath: string;
    mediaFields: readonly string[];
    requiredScopes: readonly string[];
    usageHeaders: readonly string[];
  }>;
  authorization: Readonly<{
    accountIdentityReturned: boolean;
    accountOwnership: "owned" | "managed";
    accountType: "BUSINESS" | "CREATOR" | "UNKNOWN";
    grantedScopes: readonly string[];
    redirectUriHttps: boolean;
    tokenExpiresInObserved: boolean;
    tokenResponseFields: readonly string[];
  }>;
  media: Readonly<{
    paginationObserved: boolean;
    pagesVisited: number;
    recentNewerThanOlder: boolean;
    selectedReelCount: number;
  }>;
  insights: readonly SafeInsightCase[];
  negativeCases: Readonly<{
    liveUnsupportedMetricErrorObserved: boolean;
    rateLimitFixture: string;
  }>;
  responseMetadata: Readonly<{
    providerVersionHeaders: readonly string[];
    usage: readonly SafeUsageObservation[];
  }>;
  checks: readonly SafeCheck[];
}>;

type MetaResponse = Readonly<{
  body: unknown;
  headers: Headers;
  ok: boolean;
  status: number;
}>;

type MediaRecord = Readonly<{
  id: string;
  mediaProductType: string;
  publishedAtMilliseconds: number;
}>;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MetaContractConfigurationError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`Meta contract proof configuration is incomplete or invalid: ${fields.join(", ")}`);
    this.name = "MetaContractConfigurationError";
    this.fields = fields;
  }
}

export class MetaContractRequestError extends Error {
  readonly requestName: string;
  readonly status: number;

  constructor(requestName: string, status: number) {
    super(`Meta contract request ${requestName} failed with HTTP ${status}.`);
    this.name = "MetaContractRequestError";
    this.requestName = requestName;
    this.status = status;
  }
}

function required(environment: Readonly<Record<string, string | undefined>>, field: string) {
  const value = environment[field]?.trim();
  return value ? value : null;
}

function parseCommaSeparated(value: string | null) {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function loadMetaContractConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): MetaContractConfiguration {
  const accessToken = required(environment, "META_CONTRACT_ACCESS_TOKEN");
  const accessLevel = required(environment, "META_CONTRACT_ACCESS_LEVEL");
  const accountOwnership = required(environment, "META_CONTRACT_ACCOUNT_OWNERSHIP");
  const redirectUri = required(environment, "META_CONTRACT_REDIRECT_URI");
  const mediaIds = parseCommaSeparated(required(environment, "META_CONTRACT_REEL_IDS"));
  const grantedScopes = parseCommaSeparated(required(environment, "META_CONTRACT_GRANTED_SCOPES"));
  const tokenResponseFields = parseCommaSeparated(
    required(environment, "META_CONTRACT_TOKEN_RESPONSE_FIELDS"),
  );
  const expiresInValue = required(environment, "META_CONTRACT_TOKEN_EXPIRES_IN_SECONDS");
  const fields: string[] = [];

  if (!accessToken || accessToken.length < 20) fields.push("META_CONTRACT_ACCESS_TOKEN");
  if (accessLevel !== META_CONTRACT.accessLevel) fields.push("META_CONTRACT_ACCESS_LEVEL");
  if (accountOwnership !== "owned" && accountOwnership !== "managed") {
    fields.push("META_CONTRACT_ACCOUNT_OWNERSHIP");
  }

  let parsedRedirect: URL | null;
  try {
    parsedRedirect = redirectUri ? new URL(redirectUri) : null;
  } catch {
    parsedRedirect = null;
  }
  if (
    !parsedRedirect ||
    parsedRedirect.protocol !== "https:" ||
    parsedRedirect.username ||
    parsedRedirect.password ||
    parsedRedirect.hash
  ) {
    fields.push("META_CONTRACT_REDIRECT_URI");
  }

  if (
    mediaIds.length !== 3 ||
    new Set(mediaIds).size !== 3 ||
    mediaIds.some((id) => !providerId.test(id))
  ) {
    fields.push("META_CONTRACT_REEL_IDS");
  }

  const exactScopes = [...META_CONTRACT.requiredScopes].sort().join(",");
  if ([...new Set(grantedScopes)].sort().join(",") !== exactScopes) {
    fields.push("META_CONTRACT_GRANTED_SCOPES");
  }

  if (
    tokenResponseFields.length === 0 ||
    !tokenResponseFields.includes("access_token") ||
    tokenResponseFields.some((field) => !safeTokenFieldName.test(field))
  ) {
    fields.push("META_CONTRACT_TOKEN_RESPONSE_FIELDS");
  }

  let tokenExpiresInSeconds: number | null = null;
  if (expiresInValue !== null) {
    tokenExpiresInSeconds = Number(expiresInValue);
    if (!Number.isInteger(tokenExpiresInSeconds) || tokenExpiresInSeconds <= 0) {
      fields.push("META_CONTRACT_TOKEN_EXPIRES_IN_SECONDS");
    }
  }

  if (fields.length > 0) throw new MetaContractConfigurationError([...new Set(fields)]);

  return Object.freeze({
    accessLevel: "standard",
    accessToken: accessToken as string,
    accountOwnership: accountOwnership as "owned" | "managed",
    grantedScopes: Object.freeze([...grantedScopes]),
    outputPath:
      required(environment, "META_CONTRACT_OUTPUT_PATH") ??
      "artifacts/meta-contract/live-proof.json",
    redirectUri: redirectUri as string,
    selectedMediaIds: Object.freeze([...mediaIds]) as unknown as readonly [string, string, string],
    tokenExpiresInSeconds,
    tokenResponseFields: Object.freeze([...tokenResponseFields]),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, field: string) {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function collectNumbers(value: unknown): number[] {
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(collectNumbers);
  if (isRecord(value)) return Object.values(value).flatMap(collectNumbers);
  return [];
}

function safeUsage(headers: Headers): SafeUsageObservation[] {
  return META_CONTRACT.usageHeaders.flatMap((header) => {
    const value = headers.get(header);
    if (!value) return [];

    let maximumPercentage: number | null;
    try {
      const values = collectNumbers(JSON.parse(value));
      maximumPercentage = values.length > 0 ? Math.max(...values) : null;
    } catch {
      maximumPercentage = null;
    }
    return [{ header, maximumPercentage }];
  });
}

function classifyError(status: number, body: unknown): SafeInsightCase["errorClass"] {
  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "permission";

  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = error && typeof error.code === "number" ? error.code : null;
  const subcode = error && typeof error.error_subcode === "number" ? error.error_subcode : null;
  if (status === 400 && (code === 100 || subcode === 2108006)) return "unsupported";
  return "provider";
}

function countInsightAvailability(body: unknown) {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  let available = 0;
  let unavailable = 0;

  for (const item of data) {
    if (!isRecord(item)) continue;
    const values = Array.isArray(item.values) ? item.values : [];
    const totalValue = isRecord(item.total_value) ? item.total_value.value : undefined;
    const hasNumericValue =
      typeof totalValue === "number" ||
      values.some((entry) => isRecord(entry) && typeof entry.value === "number");
    if (hasNumericValue) available += 1;
    else unavailable += 1;
  }

  if (data.length === 0) unavailable += 1;
  return { available, unavailable };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestMeta(
  fetchImplementation: FetchLike,
  accessToken: string,
  path: string,
  query: Readonly<Record<string, string>>,
): Promise<MetaResponse> {
  const url = new URL(`https://${META_CONTRACT.graphHost}/${META_CONTRACT.apiVersion}/${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "StudioParallelMetaContract/1.0",
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MetaContractRequestError("provider_transport", 0);
  }

  return {
    body: await readJson(response),
    headers: response.headers,
    ok: response.ok,
    status: response.status,
  };
}

function extractMedia(body: unknown): MediaRecord[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = getString(item, "id");
    const mediaProductType = getString(item, "media_product_type");
    const timestamp = getString(item, "timestamp");
    const publishedAtMilliseconds = timestamp ? Date.parse(timestamp) : Number.NaN;
    if (!id || !mediaProductType || !Number.isFinite(publishedAtMilliseconds)) return [];
    return [
      {
        id,
        mediaProductType: mediaProductType === "REELS" ? "REELS" : "OTHER",
        publishedAtMilliseconds,
      },
    ];
  });
}

function extractAfterCursor(body: unknown) {
  if (!isRecord(body) || !isRecord(body.paging) || !isRecord(body.paging.cursors)) return null;
  return getString(body.paging.cursors, "after");
}

function hasNextPage(body: unknown) {
  return isRecord(body) && isRecord(body.paging) && typeof body.paging.next === "string";
}

function versionHeaders(headers: Headers) {
  return META_CONTRACT.versionHeaders.flatMap((header) => {
    const value = headers.get(header);
    if (!value) return [];
    return [`${header}:${/^v\d{1,3}\.\d{1,3}$/u.test(value) ? value : "unparseable"}`];
  });
}

export async function runMetaContractProof(
  configuration: MetaContractConfiguration,
  options: Readonly<{ fetchImplementation?: FetchLike; now?: () => Date }> = {},
): Promise<SanitizedMetaContractProof> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const usage: SafeUsageObservation[] = [];
  const observedVersionHeaders = new Set<string>();

  const accountResponse = await requestMeta(fetchImplementation, configuration.accessToken, "me", {
    fields: META_CONTRACT.accountFields.join(","),
  });
  usage.push(...safeUsage(accountResponse.headers));
  versionHeaders(accountResponse.headers).forEach((value) => observedVersionHeaders.add(value));
  if (!accountResponse.ok)
    throw new MetaContractRequestError("account_identity", accountResponse.status);
  if (!isRecord(accountResponse.body)) throw new MetaContractRequestError("account_identity", 502);

  const accountId = getString(accountResponse.body, "id");
  const accountTypeValue = getString(accountResponse.body, "account_type")?.toUpperCase();
  const accountType =
    accountTypeValue === "BUSINESS" || accountTypeValue === "CREATOR"
      ? accountTypeValue
      : "UNKNOWN";
  if (!accountId || !providerId.test(accountId)) {
    throw new MetaContractRequestError("account_identity", 502);
  }

  const selected = new Set(configuration.selectedMediaIds);
  const mediaById = new Map<string, MediaRecord>();
  let after: string | null = null;
  let pagesVisited = 0;
  let paginationObserved = false;

  while (pagesVisited < META_CONTRACT.maximumMediaPages && mediaById.size < selected.size) {
    const query: Record<string, string> = {
      fields: META_CONTRACT.mediaFields.join(","),
      limit: String(META_CONTRACT.mediaPageSize),
    };
    if (after) query.after = after;

    const page = await requestMeta(
      fetchImplementation,
      configuration.accessToken,
      `${accountId}/media`,
      query,
    );
    usage.push(...safeUsage(page.headers));
    versionHeaders(page.headers).forEach((value) => observedVersionHeaders.add(value));
    if (!page.ok) throw new MetaContractRequestError("owned_media", page.status);
    pagesVisited += 1;

    for (const media of extractMedia(page.body)) {
      if (selected.has(media.id)) mediaById.set(media.id, media);
    }

    const nextCursor = extractAfterCursor(page.body);
    if (!hasNextPage(page.body)) break;
    if (!nextCursor) throw new MetaContractRequestError("owned_media_pagination", 502);
    paginationObserved = true;
    after = nextCursor;
  }

  const insights: SafeInsightCase[] = [];
  for (const [index, mediaId] of configuration.selectedMediaIds.entries()) {
    const media = mediaById.get(mediaId);
    let availableMetricCount = 0;
    let unavailableMetricCount = 0;
    let errorClass: SafeInsightCase["errorClass"] = "none";
    let metricGroupsAttempted = 0;

    if (media) {
      for (const metrics of Object.values(META_CONTRACT.insightGroups)) {
        const response = await requestMeta(
          fetchImplementation,
          configuration.accessToken,
          `${mediaId}/insights`,
          { metric: metrics.join(",") },
        );
        metricGroupsAttempted += 1;
        usage.push(...safeUsage(response.headers));
        versionHeaders(response.headers).forEach((value) => observedVersionHeaders.add(value));
        if (response.ok) {
          const counts = countInsightAvailability(response.body);
          availableMetricCount += counts.available;
          unavailableMetricCount += counts.unavailable;
        } else if (errorClass === "none") {
          errorClass = classifyError(response.status, response.body);
        }
      }
    }

    insights.push({
      availableMetricCount,
      errorClass,
      label: evidenceLabels[index] as (typeof evidenceLabels)[number],
      metricGroupsAttempted,
      productType: media?.mediaProductType ?? "NOT_FOUND",
      unavailableMetricCount,
    });
  }

  let unsupportedMetricObserved = false;
  if (mediaById.has(configuration.selectedMediaIds[2])) {
    const errorProbe = await requestMeta(
      fetchImplementation,
      configuration.accessToken,
      `${configuration.selectedMediaIds[2]}/insights`,
      { metric: META_CONTRACT.invalidMetricProbe },
    );
    usage.push(...safeUsage(errorProbe.headers));
    versionHeaders(errorProbe.headers).forEach((value) => observedVersionHeaders.add(value));
    unsupportedMetricObserved =
      !errorProbe.ok && classifyError(errorProbe.status, errorProbe.body) === "unsupported";
  }
  const thirdInsight = insights[2];
  if (unsupportedMetricObserved && thirdInsight) {
    insights[2] = { ...thirdInsight, errorClass: "unsupported" };
  }

  const uniqueUsage = new Map<string, SafeUsageObservation>();
  for (const observation of usage) {
    const existing = uniqueUsage.get(observation.header);
    const values = [existing?.maximumPercentage, observation.maximumPercentage].filter(
      (value): value is number => typeof value === "number",
    );
    uniqueUsage.set(observation.header, {
      header: observation.header,
      maximumPercentage: values.length > 0 ? Math.max(...values) : null,
    });
  }

  const recentRecord = mediaById.get(configuration.selectedMediaIds[0]);
  const olderRecord = mediaById.get(configuration.selectedMediaIds[1]);
  const recentNewerThanOlder = Boolean(
    recentRecord &&
    olderRecord &&
    recentRecord.publishedAtMilliseconds > olderRecord.publishedAtMilliseconds,
  );

  const checks: SafeCheck[] = [
    { name: "professional_account", passed: accountType !== "UNKNOWN" },
    { name: "least_privilege_scopes", passed: true },
    { name: "owned_reels_returned", passed: mediaById.size === 3 },
    {
      name: "reel_classification",
      passed: [...mediaById.values()].every((item) => item.mediaProductType === "REELS"),
    },
    { name: "cursor_pagination", passed: paginationObserved },
    { name: "representative_age_order", passed: recentNewerThanOlder },
    {
      name: "supported_insight",
      passed: insights.some((item) => item.availableMetricCount > 0),
    },
    {
      name: "unavailable_insight",
      passed: insights.some((item) => item.unavailableMetricCount > 0),
    },
    { name: "unsupported_insight_error", passed: unsupportedMetricObserved },
    { name: "usage_header", passed: uniqueUsage.size > 0 },
    {
      name: "provider_version_header",
      passed: [...observedVersionHeaders].some((value) =>
        value.endsWith(`:${META_CONTRACT.apiVersion}`),
      ),
    },
    { name: "token_response_metadata", passed: configuration.tokenResponseFields.length > 0 },
  ];

  const proof: SanitizedMetaContractProof = {
    schemaVersion: META_CONTRACT.schemaVersion,
    kind: "sanitized-meta-contract-proof",
    observedAt: now().toISOString(),
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    contract: {
      accessLevel: META_CONTRACT.accessLevel,
      apiVersion: META_CONTRACT.apiVersion,
      graphHost: META_CONTRACT.graphHost,
      insightGroups: META_CONTRACT.insightGroups,
      loginPath: META_CONTRACT.loginPath,
      mediaFields: META_CONTRACT.mediaFields,
      requiredScopes: META_CONTRACT.requiredScopes,
      usageHeaders: META_CONTRACT.usageHeaders,
    },
    authorization: {
      accountIdentityReturned: Boolean(accountId),
      accountOwnership: configuration.accountOwnership,
      accountType,
      grantedScopes: configuration.grantedScopes,
      redirectUriHttps: new URL(configuration.redirectUri).protocol === "https:",
      tokenExpiresInObserved: configuration.tokenExpiresInSeconds !== null,
      tokenResponseFields: configuration.tokenResponseFields,
    },
    media: {
      paginationObserved,
      pagesVisited,
      recentNewerThanOlder,
      selectedReelCount: mediaById.size,
    },
    insights,
    negativeCases: {
      liveUnsupportedMetricErrorObserved: unsupportedMetricObserved,
      rateLimitFixture: "tests/fixtures/meta/instagram-v25/rate-limit.json",
    },
    responseMetadata: {
      providerVersionHeaders: [...observedVersionHeaders].sort(),
      usage: [...uniqueUsage.values()].sort((left, right) =>
        left.header.localeCompare(right.header),
      ),
    },
    checks,
  };

  assertSanitizedProof(proof, [
    configuration.accessToken,
    accountId,
    ...configuration.selectedMediaIds,
  ]);
  return proof;
}

const forbiddenKeys = new Set([
  "accessToken",
  "caption",
  "cursor",
  "id",
  "media_url",
  "payload",
  "permalink",
  "raw",
  "requestUrl",
  "response",
  "signedUrl",
  "tokenValue",
  "username",
]);

export function assertSanitizedProof(proof: unknown, sensitiveValues: readonly string[] = []) {
  if (!isRecord(proof) || proof.kind !== "sanitized-meta-contract-proof") {
    throw new Error("Meta contract proof has an unsupported schema.");
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key))
        throw new Error(`Meta contract proof contains forbidden key ${key}.`);
      visit(child);
    }
  };
  visit(proof);

  const serialized = JSON.stringify(proof);
  for (const sensitiveValue of sensitiveValues.filter((value) => value.length > 0)) {
    if (serialized.includes(sensitiveValue)) {
      throw new Error("Meta contract proof retained a sensitive input value.");
    }
  }
  if (/\bEAA[A-Za-z0-9]{20,}\b/u.test(serialized)) {
    throw new Error("Meta contract proof contains an access-token-shaped value.");
  }
  if (/https?:\/\/[^\s"]+[?&](?:access_token|code|client_secret)=/iu.test(serialized)) {
    throw new Error("Meta contract proof contains a credential-bearing URL.");
  }
}

export async function writeSanitizedProof(
  proof: SanitizedMetaContractProof,
  outputPath: string,
  repositoryRoot = process.cwd(),
) {
  assertSanitizedProof(proof);
  const absolutePath = resolve(repositoryRoot, outputPath);
  const allowedRoot = resolve(repositoryRoot, "artifacts", "meta-contract");
  const pathWithinAllowedRoot = relative(allowedRoot, absolutePath);
  if (pathWithinAllowedRoot.startsWith("..") || isAbsolute(pathWithinAllowedRoot)) {
    throw new MetaContractConfigurationError(["META_CONTRACT_OUTPUT_PATH"]);
  }
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return absolutePath;
}
