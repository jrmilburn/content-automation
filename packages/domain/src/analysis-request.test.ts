import { describe, expect, it } from "vitest";

import {
  analysisRunKey,
  createAnalysisRequestSignature,
  evaluateAnalysisEligibility,
  extractAnalysisFeatures,
  isAnalyticsEligible,
} from "./analysis-request.js";
import type { PostCreativeAnalysisV1 } from "./analysis-contract.js";

const inputs = {
  instagramPostId: "post_1",
  transcriptRevisionId: null,
  videoAssetId: "asset_1",
} as const;

describe("createAnalysisRequestSignature", () => {
  it("is stable for identical inputs, so the same question is asked once", () => {
    expect(createAnalysisRequestSignature(inputs)).toBe(createAnalysisRequestSignature(inputs));
    expect(createAnalysisRequestSignature(inputs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the video changes", () => {
    // Replacing a post's source video is a new question about a new file.
    expect(createAnalysisRequestSignature({ ...inputs, videoAssetId: "asset_2" })).not.toBe(
      createAnalysisRequestSignature(inputs),
    );
  });

  it("changes when a transcript appears", () => {
    expect(
      createAnalysisRequestSignature({ ...inputs, transcriptRevisionId: "transcript_1" }),
    ).not.toBe(createAnalysisRequestSignature(inputs));
  });

  it("distinguishes two posts sharing nothing but a contract", () => {
    expect(createAnalysisRequestSignature({ ...inputs, instagramPostId: "post_2" })).not.toBe(
      createAnalysisRequestSignature(inputs),
    );
  });

  it("derives a job key that is safe as an idempotency key", () => {
    expect(analysisRunKey(createAnalysisRequestSignature(inputs))).toMatch(
      /^analysis-run-[0-9a-f]{64}$/,
    );
  });
});

describe("evaluateAnalysisEligibility", () => {
  const ready = {
    instagramPostId: "post_1",
    videoAssetId: "asset_1",
    videoAssetState: "READY",
  } as const;

  it("pins what would be analysed when everything is ready", () => {
    const result = evaluateAnalysisEligibility(ready);

    expect(result).toMatchObject({ eligible: true });
    expect(result).toHaveProperty("signature", createAnalysisRequestSignature(inputs));
  });

  it("refuses a post with no source video", () => {
    expect(
      evaluateAnalysisEligibility({ ...ready, videoAssetId: null, videoAssetState: null }),
    ).toEqual({ eligible: false, reason: "no_source_video" });
  });

  it.each(["PENDING_VALIDATION", "REJECTED"])("refuses an asset in state %s", (videoAssetState) => {
    // Sending an unvalidated object to a paid provider would spend money to
    // learn what a local probe answers for free.
    expect(evaluateAnalysisEligibility({ ...ready, videoAssetState })).toEqual({
      eligible: false,
      reason: "asset_not_ready",
    });
  });

  it("refuses an absent post before looking at anything else", () => {
    expect(
      evaluateAnalysisEligibility({ ...ready, instagramPostId: null, videoAssetId: null }),
    ).toEqual({ eligible: false, reason: "post_not_found" });
  });
});

function observation<T>(value: T, availability = "available") {
  return {
    availability,
    basis: "observed",
    confidence: "high",
    evidence: [],
    limitation: null,
    value,
  };
}

function analysis(overrides: Record<string, unknown> = {}): PostCreativeAnalysisV1 {
  return {
    callToAction: {
      present: observation(true),
      text: observation("Follow"),
      type: observation("follow"),
    },
    content: {
      contentFormat: observation("educational"),
      contentPillar: observation("education_and_insight"),
      durationSeconds: observation(30),
      hook: { category: observation("question") },
      presenterMode: observation("founder_led"),
    },
    quality: { overallConfidence: "high" },
    ...overrides,
  } as unknown as PostCreativeAnalysisV1;
}

describe("extractAnalysisFeatures", () => {
  it("lifts the fields analytics groups by", () => {
    expect(extractAnalysisFeatures(analysis())).toEqual({
      contentFormat: "educational",
      contentPillar: "education_and_insight",
      ctaType: "follow",
      durationSeconds: 30,
      hookCategory: "question",
      overallConfidence: "high",
      presenterMode: "founder_led",
    });
  });

  it("extracts an unavailable observation as null rather than its value", () => {
    const input = analysis();
    Reflect.set(input.content, "contentPillar", observation(null, "unknown"));

    expect(extractAnalysisFeatures(input).contentPillar).toBeNull();
  });

  it("extracts an unknown taxonomy value as null", () => {
    // Grouping by "unknown" would create a cohort of posts we could not read
    // that looks like a creative choice.
    const input = analysis();
    Reflect.set(input.content, "contentFormat", observation("unknown"));

    expect(extractAnalysisFeatures(input).contentFormat).toBeNull();
  });
});

describe("isAnalyticsEligible", () => {
  it.each(["high", "medium"])("includes a %s confidence analysis", (overallConfidence) => {
    expect(isAnalyticsEligible(analysis({ quality: { overallConfidence } }))).toBe(true);
  });

  it("excludes a low confidence analysis from grouping", () => {
    // It still belongs in the record and on the post's detail screen; it does
    // not belong in a median.
    expect(isAnalyticsEligible(analysis({ quality: { overallConfidence: "low" } }))).toBe(false);
  });
});
