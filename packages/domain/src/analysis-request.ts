import { createHash } from "node:crypto";

import {
  analysisContractArtifacts,
  analysisModelRequested,
  analysisPromptVersion,
  analysisSchemaVersion,
  type PostCreativeAnalysisV1,
} from "./analysis-contract.js";

/**
 * What identifies one request to analyse one video, and whether it may run.
 *
 * The signature is the whole idempotency story. Gemini charges per request and
 * a video costs real money to upload and read, so "have we already asked this
 * exact question" has to be answerable before any provider call, from values
 * the caller already holds. It covers the inputs and the contract: the same
 * video under a new prompt is a different question and must be asked again,
 * while the same video under the same contract must not be.
 *
 * This module performs no network, storage or logging work.
 */

/** Why a post cannot be analysed right now. */
export const analysisIneligibilityReasons = [
  "asset_not_ready",
  "no_source_video",
  "post_not_found",
] as const;

export type AnalysisIneligibilityReason = (typeof analysisIneligibilityReasons)[number];

export type AnalysisRequestInputs = Readonly<{
  instagramPostId: string;
  /** Null when no transcript exists yet; #39 introduces them. */
  transcriptRevisionId: string | null;
  videoAssetId: string;
}>;

/**
 * Hashes the inputs and the contract that will be applied to them.
 *
 * The contract versions are included rather than assumed, so activating a new
 * prompt makes every post eligible for a fresh analysis without anyone having
 * to invalidate anything. The asset ID rather than the post is what pins the
 * video: replacing a post's source video is a new analysis, and re-requesting
 * against the same asset is not.
 */
export function createAnalysisRequestSignature(inputs: AnalysisRequestInputs): string {
  const canonical = JSON.stringify([
    "post-analysis-request-v1",
    inputs.instagramPostId,
    inputs.videoAssetId,
    inputs.transcriptRevisionId,
    analysisSchemaVersion,
    analysisContractArtifacts.schema.sha256,
    analysisPromptVersion,
    analysisContractArtifacts.prompt.sha256,
    analysisModelRequested,
  ]);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The idempotency key the background job carries, derived from the signature. */
export function analysisRunKey(signature: string): string {
  return `analysis-run-${signature}`;
}

export type AnalysisEligibility =
  | Readonly<{ eligible: true; inputs: AnalysisRequestInputs; signature: string }>
  | Readonly<{ eligible: false; reason: AnalysisIneligibilityReason }>;

export type AnalysisEligibilityInput = Readonly<{
  instagramPostId: string | null;
  transcriptRevisionId?: string | null;
  videoAssetId: string | null;
  videoAssetState: string | null;
}>;

/**
 * Decides whether a post can be analysed, and pins what would be analysed.
 *
 * A pending asset is refused rather than queued behind validation. The
 * validation worker is what decides a file is a video at all, and sending an
 * unvalidated object to a paid provider would spend money to learn what a local
 * probe already answers for free.
 */
export function evaluateAnalysisEligibility(input: AnalysisEligibilityInput): AnalysisEligibility {
  if (input.instagramPostId === null) {
    return Object.freeze({ eligible: false, reason: "post_not_found" });
  }
  if (input.videoAssetId === null) {
    return Object.freeze({ eligible: false, reason: "no_source_video" });
  }
  if (input.videoAssetState !== "READY") {
    return Object.freeze({ eligible: false, reason: "asset_not_ready" });
  }

  const inputs: AnalysisRequestInputs = Object.freeze({
    instagramPostId: input.instagramPostId,
    transcriptRevisionId: input.transcriptRevisionId ?? null,
    videoAssetId: input.videoAssetId,
  });

  return Object.freeze({
    eligible: true,
    inputs,
    signature: createAnalysisRequestSignature(inputs),
  });
}

export type AnalysisFeatureColumns = Readonly<{
  contentFormat: string | null;
  contentPillar: string | null;
  ctaType: string | null;
  durationSeconds: number | null;
  hookCategory: string | null;
  overallConfidence: string;
  presenterMode: string | null;
}>;

/**
 * Lifts the fields analytics groups by out of the stored result.
 *
 * Analytics compares thousands of posts by feature value; parsing a JSON
 * document per row to read one enum would make every trend query a table scan
 * of documents. These are extracted copies, not a second source of truth — the
 * validated `result` remains authoritative.
 *
 * An unavailable observation extracts as null rather than as its taxonomy
 * value. `unknown` means the model could not classify the field, and grouping
 * by it would create a cohort of "posts we could not read" that looks like a
 * creative choice.
 */
export function extractAnalysisFeatures(analysis: PostCreativeAnalysisV1): AnalysisFeatureColumns {
  const available = <T>(observation: Readonly<{ availability: string; value: T }>): T | null =>
    observation.availability === "available" ? observation.value : null;

  const taxonomy = (
    observation: Readonly<{ availability: string; value: string | null }>,
  ): string | null => {
    const value = available(observation);

    return value === null || value === "unknown" ? null : value;
  };

  return Object.freeze({
    contentFormat: taxonomy(analysis.content.contentFormat),
    contentPillar: taxonomy(analysis.content.contentPillar),
    ctaType: taxonomy(analysis.callToAction.type),
    durationSeconds: available(analysis.content.durationSeconds),
    hookCategory: taxonomy(analysis.content.hook.category),
    overallConfidence: analysis.quality.overallConfidence,
    presenterMode: taxonomy(analysis.content.presenterMode),
  });
}

/**
 * Whether an analysis is solid enough for analytics to group by.
 *
 * A low-confidence analysis still belongs in the record and on the post's
 * detail screen; it does not belong in a median. Excluding it here rather than
 * filtering at query time means the exclusion is one stored decision that
 * analytics can count, which the contract requires it to report as a
 * limitation.
 */
export function isAnalyticsEligible(analysis: PostCreativeAnalysisV1): boolean {
  return analysis.quality.overallConfidence !== "low";
}
