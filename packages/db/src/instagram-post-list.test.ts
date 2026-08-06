import { describe, expect, it } from "vitest";

import { resolveAnalysisState } from "./instagram-post-list.js";

/**
 * The rest of this module needs a database and is covered by
 * `tests/integration/instagram-post-list.integration.test.ts`. This resolver
 * does not: it is a decision about which of three answers a row deserves, and
 * the decision is worth holding still on its own.
 */
describe("resolveAnalysisState", () => {
  it("reports a published analysis as analysed", () => {
    expect(resolveAnalysisState("019a0000-0000-7000-8000-000000000501", [])).toBe("ANALYSED");
  });

  it("prefers a published analysis over a re-analysis still running", () => {
    // A post can be analysed again while it already has one. "Analysed" is the
    // truer answer for a reader deciding what still needs attention.
    expect(
      resolveAnalysisState("019a0000-0000-7000-8000-000000000501", [{ stage: "REQUESTING" }]),
    ).toBe("ANALYSED");
  });

  it("reports a live job as in progress", () => {
    expect(resolveAnalysisState(null, [{ stage: "QUEUED" }])).toBe("IN_PROGRESS");
  });

  it("treats an unknown stage as running rather than as untouched", () => {
    // The two terminal stages are listed rather than the six live ones,
    // because a stage added later is far more likely to be another step on the
    // way than another way to stop. Guessing the other way would make a post
    // mid-analysis look like one nothing had touched, and invite a second
    // request for work already under way.
    expect(resolveAnalysisState(null, [{ stage: "SOME_FUTURE_STAGE" }])).toBe("IN_PROGRESS");
  });

  it.each(["PUBLISHED", "ABANDONED"])(
    "does not report a %s job as still running",
    (stage: string) => {
      // PUBLISHED with no current analysis means the publish lost a race to a
      // newer one; ABANDONED means it stopped. Neither is work in flight.
      expect(resolveAnalysisState(null, [{ stage }])).toBe("NONE");
    },
  );

  it("reports a post with no analysis and no job as untouched", () => {
    expect(resolveAnalysisState(null, [])).toBe("NONE");
  });

  it("finds one live job among finished ones", () => {
    expect(
      resolveAnalysisState(null, [
        { stage: "ABANDONED" },
        { stage: "VALIDATING" },
        { stage: "ABANDONED" },
      ]),
    ).toBe("IN_PROGRESS");
  });
});
