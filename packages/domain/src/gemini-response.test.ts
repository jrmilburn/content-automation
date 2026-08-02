import { describe, expect, it } from "vitest";

import {
  classifyGeminiCandidate,
  classifyGeminiFileState,
  classifyGeminiResponse,
  isGeminiFileName,
  parseGeminiRetryAfterMs,
  readGeminiUsage,
} from "./gemini-response.js";

function providerError(status: string) {
  return { error: { code: 400, message: "should never be read", status } };
}

describe("classifyGeminiResponse", () => {
  it.each([
    [429, "rate_limit"],
    [401, "authorisation"],
    [403, "authorisation"],
    [408, "timeout"],
    [504, "timeout"],
    [500, "transient"],
    [502, "transient"],
    [503, "transient"],
    [400, "invalid_request"],
    [404, "invalid_request"],
  ] as const)("classifies status %d as %s", (status, expected) => {
    expect(classifyGeminiResponse({ body: null, status })).toBe(expected);
  });

  it("reads status before the body so a gateway error is not read as a bad request", () => {
    // A proxy can return 429 or 502 with no JSON at all. A body-first rule would
    // spend the attempt budget on something a retry fixes.
    expect(classifyGeminiResponse({ body: providerError("INVALID_ARGUMENT"), status: 429 })).toBe(
      "rate_limit",
    );
    expect(classifyGeminiResponse({ body: "<html>gateway</html>", status: 502 })).toBe("transient");
  });

  it.each([
    ["RESOURCE_EXHAUSTED", "rate_limit"],
    ["PERMISSION_DENIED", "authorisation"],
    ["UNAUTHENTICATED", "authorisation"],
    ["UNAVAILABLE", "transient"],
    ["INTERNAL", "transient"],
    ["DEADLINE_EXCEEDED", "timeout"],
    ["INVALID_ARGUMENT", "invalid_request"],
  ] as const)("classifies provider status %s as %s", (status, expected) => {
    expect(classifyGeminiResponse({ body: providerError(status), status: 400 })).toBe(expected);
  });

  it("treats a 2xx carrying an error object as the provider disagreeing with itself", () => {
    expect(classifyGeminiResponse({ body: providerError("UNAVAILABLE"), status: 200 })).toBe(
      "transient",
    );
  });
});

describe("classifyGeminiFileState", () => {
  it.each([
    ["ACTIVE", "active"],
    ["FAILED", "failed"],
    ["PROCESSING", "pending"],
    ["STATE_UNSPECIFIED", "pending"],
    [undefined, "pending"],
  ] as const)("maps %s to %s", (state, expected) => {
    expect(classifyGeminiFileState(state)).toBe(expected);
  });
});

describe("classifyGeminiCandidate", () => {
  function candidate(overrides: Record<string, unknown> = {}) {
    return {
      candidates: [
        { content: { parts: [{ text: '{"ok":true}' }] }, finishReason: "STOP", ...overrides },
      ],
    };
  }

  it("returns the model text from the first candidate part", () => {
    expect(classifyGeminiCandidate(candidate())).toEqual({
      finishReason: "STOP",
      outcome: "ok",
      text: '{"ok":true}',
    });
  });

  it.each(["SAFETY", "PROHIBITED_CONTENT"])("reports %s as a safety block", (finishReason) => {
    expect(classifyGeminiCandidate(candidate({ finishReason }))).toMatchObject({
      outcome: "safety_blocked",
      text: null,
    });
  });

  it("keeps a truncated response apart from a complete one", () => {
    // A response cut off at the output limit is syntactically a success and
    // semantically a fragment; parsing it would fail confusingly.
    expect(classifyGeminiCandidate(candidate({ finishReason: "MAX_TOKENS" }))).toMatchObject({
      outcome: "truncated",
    });
  });

  it("reports an absent candidate rather than an empty answer", () => {
    expect(classifyGeminiCandidate({ candidates: [] })).toEqual({
      finishReason: null,
      outcome: "no_candidate",
      text: null,
    });
    expect(classifyGeminiCandidate({})).toMatchObject({ outcome: "no_candidate" });
  });

  it("reads a prompt-level block from promptFeedback, where no candidate exists", () => {
    expect(classifyGeminiCandidate({ promptFeedback: { blockReason: "SAFETY" } })).toMatchObject({
      outcome: "safety_blocked",
    });
  });

  it("reports a candidate with no text part as no candidate", () => {
    expect(classifyGeminiCandidate(candidate({ content: { parts: [] } }))).toMatchObject({
      outcome: "no_candidate",
      text: null,
    });
  });
});

describe("parseGeminiRetryAfterMs", () => {
  it("reads delta seconds", () => {
    expect(parseGeminiRetryAfterMs("30")).toBe(30_000);
    expect(parseGeminiRetryAfterMs(" 5 ")).toBe(5_000);
  });

  it("ignores an HTTP-date rather than trusting two clocks to agree", () => {
    expect(parseGeminiRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });

  it.each([null, undefined, "", "-1", "1.5", "soon"])("rejects %s", (value) => {
    expect(parseGeminiRetryAfterMs(value)).toBeNull();
  });

  it("clamps an absurd hint to a day", () => {
    expect(parseGeminiRetryAfterMs("9999999")).toBe(86_400_000);
  });
});

describe("readGeminiUsage", () => {
  it("reads every reported count", () => {
    expect(
      readGeminiUsage({
        usageMetadata: {
          cachedContentTokenCount: 5,
          candidatesTokenCount: 200,
          promptTokenCount: 1_000,
          thoughtsTokenCount: 50,
          totalTokenCount: 1_255,
        },
      }),
    ).toEqual({
      cachedTokens: 5,
      inputTokens: 1_000,
      outputTokens: 200,
      thinkingTokens: 50,
      totalTokens: 1_255,
    });
  });

  it("reports an unreported count as null rather than zero", () => {
    // Zero thinking tokens for a model that did not report them would understate
    // cost in exactly the place someone is trying to measure it.
    expect(readGeminiUsage({ usageMetadata: { promptTokenCount: 10 } })).toMatchObject({
      inputTokens: 10,
      thinkingTokens: null,
      totalTokens: null,
    });
    expect(readGeminiUsage({})).toMatchObject({ inputTokens: null });
  });

  it("rejects a non-integer or negative count", () => {
    expect(
      readGeminiUsage({ usageMetadata: { candidatesTokenCount: -1, promptTokenCount: 1.5 } }),
    ).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});

describe("isGeminiFileName", () => {
  it("accepts the provider's own name form", () => {
    expect(isGeminiFileName("files/abc123")).toBe(true);
  });

  it.each([
    "files/../../models/x",
    "files/abc?key=leak",
    "files/ABC123",
    "models/abc",
    "files/",
    "",
    null,
  ])("rejects %s so a provider value cannot choose the endpoint", (value) => {
    expect(isGeminiFileName(value)).toBe(false);
  });
});
