import { describe, expect, it } from "vitest";

import {
  assertJobTransition,
  backgroundJobStates,
  canTransitionJob,
  isSafeJobStage,
  isTerminalJobState,
} from "./job-lifecycle.js";

describe("logical job state machine", () => {
  it("allows only the documented transitions", () => {
    const allowed = new Set([
      "QUEUED:PROCESSING",
      "QUEUED:CANCELLED",
      "PROCESSING:QUEUED",
      "PROCESSING:RETRY_SCHEDULED",
      "PROCESSING:SUCCEEDED",
      "PROCESSING:FAILED_ATTENTION",
      "PROCESSING:CANCELLED",
      "RETRY_SCHEDULED:QUEUED",
      "RETRY_SCHEDULED:CANCELLED",
      "FAILED_ATTENTION:QUEUED",
    ]);

    for (const from of backgroundJobStates) {
      for (const to of backgroundJobStates) {
        expect(canTransitionJob(from, to)).toBe(allowed.has(`${from}:${to}`));
        if (allowed.has(`${from}:${to}`)) {
          expect(() => assertJobTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertJobTransition(from, to)).toThrow(
            expect.objectContaining({ code: "JOB_TRANSITION_INVALID", from, to }),
          );
        }
      }
    }
  });

  it("keeps successful and cancelled jobs terminal while failed jobs require an explicit retry", () => {
    expect(isTerminalJobState("SUCCEEDED")).toBe(true);
    expect(isTerminalJobState("CANCELLED")).toBe(true);
    expect(isTerminalJobState("FAILED_ATTENTION")).toBe(true);
    expect(canTransitionJob("FAILED_ATTENTION", "QUEUED")).toBe(true);
    expect(canTransitionJob("SUCCEEDED", "QUEUED")).toBe(false);
  });

  it("accepts only bounded machine-safe stage names", () => {
    expect(isSafeJobStage("loading_inputs")).toBe(true);
    expect(isSafeJobStage("waiting_file_2")).toBe(true);
    expect(isSafeJobStage("raw provider response")).toBe(false);
    expect(isSafeJobStage("token=secret")).toBe(false);
  });
});
