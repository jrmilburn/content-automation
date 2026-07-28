import { describe, expect, it } from "vitest";

import { classifyJobHandlerError, decideJobRetry, JobHandlerFailure } from "./job-retry.js";

const createdAt = new Date("2026-07-28T00:00:00.000Z");
const now = new Date("2026-07-28T00:10:00.000Z");

describe("job retry policy", () => {
  it("uses deterministic full jitter for transient errors and stops after five calls", () => {
    expect(
      decideJobRetry({
        attemptNumber: 1,
        failure: { errorClass: "TRANSIENT", errorCode: "PROVIDER_TIMEOUT" },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
        random: () => 0.5,
      }),
    ).toEqual({
      delayMs: 15_000,
      nextAction: "RETRY_AUTOMATIC",
      nextAttemptAt: new Date("2026-07-28T00:10:15.000Z"),
      outcome: "RETRY",
    });
    expect(
      decideJobRetry({
        attemptNumber: 5,
        failure: { errorClass: "TRANSIENT", errorCode: "PROVIDER_TIMEOUT" },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
      }),
    ).toEqual({ nextAction: "CONTACT_SUPPORT", outcome: "FAILED_ATTENTION" });
  });

  it("honours a provider retry hint without exceeding the 24-hour retry horizon", () => {
    expect(
      decideJobRetry({
        attemptNumber: 1,
        failure: {
          errorClass: "RATE_LIMIT",
          errorCode: "PROVIDER_RATE_LIMITED",
          providerRetryAfterMs: 300_000,
        },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
        random: () => 0,
      }),
    ).toEqual({
      delayMs: 300_000,
      nextAction: "RETRY_AUTOMATIC",
      nextAttemptAt: new Date("2026-07-28T00:15:00.000Z"),
      outcome: "RETRY",
    });
    expect(
      decideJobRetry({
        attemptNumber: 1,
        failure: {
          errorClass: "RATE_LIMIT",
          errorCode: "PROVIDER_RATE_LIMITED",
          providerRetryAfterMs: 86_400_001,
        },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
      }),
    ).toEqual({ nextAction: "CONTACT_SUPPORT", outcome: "FAILED_ATTENTION" });
  });

  it.each([
    [{ errorClass: "CREDENTIAL", errorCode: "TOKEN_REVOKED" }, "RECONNECT_ACCOUNT"],
    [{ errorClass: "INVALID_INPUT", errorCode: "ASSET_UNSUPPORTED" }, "REPLACE_INPUT"],
    [{ errorClass: "UNKNOWN", errorCode: "UNEXPECTED" }, "CONTACT_SUPPORT"],
  ] as const)("makes permanent %s failures terminal", (failure, nextAction) => {
    expect(
      decideJobRetry({ attemptNumber: 1, failure, jobCreatedAt: createdAt, maxAttempts: 8, now }),
    ).toEqual({ nextAction, outcome: "FAILED_ATTENTION" });
  });

  it("bounds credential refresh, semantic repair and database retries", () => {
    expect(
      decideJobRetry({
        attemptNumber: 1,
        failure: {
          credentialRecoverable: true,
          errorClass: "CREDENTIAL",
          errorCode: "TOKEN_REFRESH_REQUIRED",
        },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
        random: () => 1,
      }),
    ).toMatchObject({ delayMs: 1_000, outcome: "RETRY" });
    expect(
      decideJobRetry({
        attemptNumber: 2,
        failure: { errorClass: "SEMANTIC_OUTPUT", errorCode: "OUTPUT_INVALID" },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
      }),
    ).toEqual({ nextAction: "REVIEW_OUTPUT", outcome: "FAILED_ATTENTION" });
    expect(
      decideJobRetry({
        attemptNumber: 3,
        failure: { errorClass: "DATABASE", errorCode: "DATABASE_SERIALIZATION" },
        jobCreatedAt: createdAt,
        maxAttempts: 8,
        now,
      }),
    ).toEqual({ nextAction: "CONTACT_SUPPORT", outcome: "FAILED_ATTENTION" });
  });

  it("redacts unclassified exceptions and normalises adapter error codes", () => {
    const raw = new Error("token=do-not-store");
    const classified = classifyJobHandlerError(raw);
    const adapterFailure = classifyJobHandlerError(
      new JobHandlerFailure({ errorClass: "TRANSIENT", errorCode: "unsafe raw detail" }),
    );

    expect(classified).toEqual({ errorClass: "UNKNOWN", errorCode: "JOB_HANDLER_FAILED" });
    expect(adapterFailure).toEqual({
      errorClass: "TRANSIENT",
      errorCode: "JOB_HANDLER_FAILED",
    });
    expect(JSON.stringify([classified, adapterFailure])).not.toContain("do-not-store");
  });
});
