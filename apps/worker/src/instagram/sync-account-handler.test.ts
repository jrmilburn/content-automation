import { JobHandlerFailure, queueDefinitions } from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";
import { describe, expect, it } from "vitest";

import { InstagramMediaError } from "./media-client.js";
import { instagramSyncQueue, toJobFailure } from "./sync-account-handler.js";

describe("instagramSyncQueue", () => {
  it("matches a declared queue definition", () => {
    expect(queueDefinitions).toContainEqual({
      name: instagramSyncQueue.name,
      version: instagramSyncQueue.version,
    });
  });
});

describe("toJobFailure", () => {
  it.each([
    ["rate_limit", "RATE_LIMIT", "INSTAGRAM_RATE_LIMITED"],
    ["authorisation", "CREDENTIAL", "INSTAGRAM_TOKEN_REJECTED"],
    ["transient", "TRANSIENT", "INSTAGRAM_UNAVAILABLE"],
    ["invalid_request", "INVALID_INPUT", "INSTAGRAM_REQUEST_REJECTED"],
    ["unsupported", "INVALID_INPUT", "INSTAGRAM_REQUEST_UNSUPPORTED"],
  ] as const)("maps a %s response to %s", (responseClass, errorClass, errorCode) => {
    const failure = toJobFailure(new InstagramMediaError(responseClass, "MEDIA_PAGE_REJECTED"));

    expect(failure).toBeInstanceOf(JobHandlerFailure);
    expect(failure.failure.errorClass).toBe(errorClass);
    expect(failure.failure.errorCode).toBe(errorCode);
  });

  it("carries the provider retry hint into the retry decision", () => {
    const failure = toJobFailure(
      new InstagramMediaError("rate_limit", "MEDIA_PAGE_REJECTED", 45_000),
    );

    expect(failure.failure.providerRetryAfterMs).toBe(45_000);
  });

  it("omits an absent retry hint rather than sending zero", () => {
    const failure = toJobFailure(new InstagramMediaError("rate_limit", "MEDIA_PAGE_REJECTED"));

    expect(failure.failure.providerRetryAfterMs).toBeUndefined();
  });

  it("treats a retryable infrastructure error as a database failure", () => {
    const failure = toJobFailure(
      new OperationalError({
        code: "JOB_RESULT_COMMIT_FAILED",
        errorClass: "dependency",
        retryable: true,
        statusCode: 503,
      }),
    );

    expect(failure.failure.errorClass).toBe("DATABASE");
    expect(failure.failure.errorCode).toBe("SYNC_DATABASE_UNAVAILABLE");
  });

  it("does not retry a non-retryable operational error automatically", () => {
    const failure = toJobFailure(
      new OperationalError({
        code: "SYNC_RUN_NOT_ACTIVE",
        errorClass: "conflict",
        statusCode: 409,
      }),
    );

    expect(failure.failure.errorClass).toBe("UNKNOWN");
  });

  it("passes an already classified handler failure through unchanged", () => {
    const original = new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "SYNC_CREDENTIAL_MISSING",
    });

    expect(toJobFailure(original)).toBe(original);
  });

  it("classifies an unexpected error without leaking its message", () => {
    const failure = toJobFailure(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

    expect(failure.failure.errorClass).toBe("UNKNOWN");
    expect(failure.failure.errorCode).toBe("JOB_HANDLER_FAILED");
    expect(failure.message).not.toContain("10.0.0.5");
  });
});
