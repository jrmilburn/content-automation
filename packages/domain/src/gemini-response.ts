/**
 * Pure Gemini response classification: HTTP outcomes, file states and candidate
 * finish reasons reduced to the small set of decisions a job policy can act on.
 *
 * This module performs no network, storage or logging work so every rule can be
 * tested exhaustively, and so the worker adapter is left with nothing but HTTP
 * plumbing.
 *
 * Nothing here returns provider text in an error. A provider message is
 * untrusted, unbounded and frequently echoes the input, so failures reduce to a
 * reason code that the logger's allowlist can actually carry.
 */

/**
 * What went wrong, at the granularity job policy needs.
 *
 * `file_failed`, `safety_blocked` and `no_candidate` are kept apart from
 * `invalid_request` because they are not the caller's mistake and do not have
 * the same retry answer: a failed upload may succeed on a second attempt, while
 * a safety block on the same video never will.
 */
export const geminiResponseClasses = [
  "authorisation",
  "file_failed",
  "invalid_request",
  "no_candidate",
  "rate_limit",
  "safety_blocked",
  "timeout",
  "transient",
  // A response that ran out of output budget before it finished. Separate from
  // `no_candidate` because the two need opposite responses: an empty candidate
  // may succeed on a retry, and a truncated one will hit the same ceiling every
  // time until the ceiling moves. Collapsing them told a reader to ask again
  // when asking again could not work.
  "truncated",
] as const;

export type GeminiResponseClass = (typeof geminiResponseClasses)[number];

/**
 * Whether a response carried a usable candidate.
 *
 * `truncated` is separate from `ok` because a response cut off at the output
 * limit is syntactically a success and semantically a fragment. Treating it as
 * success would hand the handler a half-written JSON object to parse.
 */
export const geminiCandidateOutcomes = [
  "no_candidate",
  "ok",
  "safety_blocked",
  "truncated",
] as const;

export type GeminiCandidateOutcome = (typeof geminiCandidateOutcomes)[number];

/** Provider file lifecycle states, as the Files API reports them. */
export const geminiFileStates = ["ACTIVE", "FAILED", "PROCESSING", "STATE_UNSPECIFIED"] as const;

export type GeminiFileState = (typeof geminiFileStates)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorStatus(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body["error"];
  if (!isRecord(error)) return null;
  const status = error["status"];

  return typeof status === "string" ? status : null;
}

/**
 * Classifies one HTTP response from the Gemini API.
 *
 * Status is read before the body, because a proxy or gateway can return a 429 or
 * a 502 with no JSON at all, and a body-first rule would misread those as
 * malformed requests and burn the attempt budget on something a retry fixes.
 */
export function classifyGeminiResponse(
  input: Readonly<{ body: unknown; status: number }>,
): GeminiResponseClass {
  const { body, status } = input;

  if (status === 429) return "rate_limit";
  if (status === 401 || status === 403) return "authorisation";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "transient";

  const providerStatus = readErrorStatus(body);

  if (providerStatus === "RESOURCE_EXHAUSTED") return "rate_limit";
  if (providerStatus === "PERMISSION_DENIED" || providerStatus === "UNAUTHENTICATED") {
    return "authorisation";
  }
  if (providerStatus === "UNAVAILABLE" || providerStatus === "INTERNAL") return "transient";
  if (providerStatus === "DEADLINE_EXCEEDED") return "timeout";

  if (status >= 400) return "invalid_request";

  // A 2xx that still carries an error object is the provider disagreeing with
  // itself. Treating it as success would hand the caller an empty candidate.
  return providerStatus === null ? "invalid_request" : "transient";
}

/** Classifies a Files API state into the terminal outcome it implies. */
export function classifyGeminiFileState(state: unknown): "active" | "failed" | "pending" {
  if (state === "ACTIVE") return "active";
  if (state === "FAILED") return "failed";

  return "pending";
}

/**
 * Reads the usable text from a `generateContent` body.
 *
 * The model's output is a JSON string inside the first candidate's first part,
 * so an absent part is not an empty answer: it means the request produced no
 * content at all and must not be parsed as one.
 */
export function classifyGeminiCandidate(
  body: unknown,
): Readonly<{ finishReason: string | null; outcome: GeminiCandidateOutcome; text: string | null }> {
  const candidates = isRecord(body) ? body["candidates"] : undefined;
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;

  if (!isRecord(candidate)) {
    const blocked = isRecord(body) && isRecord(body["promptFeedback"]);
    return Object.freeze({
      finishReason: null,
      // A prompt-level block reports no candidate at all, so the distinction has
      // to come from promptFeedback rather than from the missing candidate.
      outcome: blocked ? "safety_blocked" : "no_candidate",
      text: null,
    });
  }

  const rawFinishReason = candidate["finishReason"];
  const finishReason = typeof rawFinishReason === "string" ? rawFinishReason : null;

  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") {
    return Object.freeze({ finishReason, outcome: "safety_blocked", text: null });
  }

  const content = candidate["content"];
  const parts = isRecord(content) ? content["parts"] : undefined;
  const part = Array.isArray(parts) ? parts[0] : undefined;
  const text = isRecord(part) && typeof part["text"] === "string" ? part["text"] : null;

  if (finishReason === "MAX_TOKENS") {
    return Object.freeze({ finishReason, outcome: "truncated", text });
  }
  if (text === null) {
    return Object.freeze({ finishReason, outcome: "no_candidate", text: null });
  }

  return Object.freeze({ finishReason, outcome: "ok", text });
}

const maximumRetryAfterMs = 86_400_000;

/**
 * Reads a `Retry-After` header in delta-seconds.
 *
 * The HTTP-date form is ignored rather than parsed, matching the Instagram
 * client: a date depends on agreement about the current time between two
 * machines, and a wrong one produces either a hot retry loop or a job parked for
 * a day. An absent hint lets the retry policy use its own backoff.
 */
export function parseGeminiRetryAfterMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!/^\d{1,7}$/u.test(trimmed)) return null;

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return Math.min(seconds * 1_000, maximumRetryAfterMs);
}

/**
 * Reads token usage from `usageMetadata`.
 *
 * Every field is optional because the provider omits counts it did not charge
 * for, and a missing count is not zero: reporting zero thinking tokens for a
 * model that did not report them would understate cost in exactly the place
 * someone is trying to measure it.
 */
export type GeminiUsage = Readonly<{
  cachedTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
}>;

function readCount(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];

  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function readGeminiUsage(body: unknown): GeminiUsage {
  const usage = isRecord(body) ? body["usageMetadata"] : undefined;

  if (!isRecord(usage)) {
    return Object.freeze({
      cachedTokens: null,
      inputTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      totalTokens: null,
    });
  }

  return Object.freeze({
    cachedTokens: readCount(usage, "cachedContentTokenCount"),
    inputTokens: readCount(usage, "promptTokenCount"),
    outputTokens: readCount(usage, "candidatesTokenCount"),
    thinkingTokens: readCount(usage, "thoughtsTokenCount"),
    totalTokens: readCount(usage, "totalTokenCount"),
  });
}

/**
 * Provider file names, as they may be interpolated into a URL path.
 *
 * The name comes back from the provider and is then sent to a poll and a delete,
 * so it is validated rather than trusted: a name carrying a traversal or a query
 * would otherwise choose the endpoint.
 */
const fileNamePattern = /^files\/[a-z0-9]{1,64}$/u;

export function isGeminiFileName(value: unknown): value is string {
  return typeof value === "string" && fileNamePattern.test(value);
}
