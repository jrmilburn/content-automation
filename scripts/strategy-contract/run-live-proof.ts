import { argv, env, exit } from "node:process";

import {
  completeStrategyV1,
  createStrategyInstruction,
  renderStrategyManifest,
  strategyModelRequested,
  toStrategyManifestEvidence,
  validateStrategyV1,
  type StrategyEvidenceEntry,
  type StrategyMode,
} from "@studio-parallel/domain";

/**
 * Proves the strategy request against the real Gemini API.
 *
 * This exists for the reason #122 established and #126 confirmed: the
 * repository asserted Gemini's behaviour from local assumptions.
 * `assertGeminiStructuredOutputSchema` passed on a strategy request the API
 * rejects on both provider-schema paths, so the contract looked correct for as
 * long as nobody sent it anywhere.
 *
 * It is deliberately not part of `npm run check` or CI: it spends money and
 * depends on a provider being reachable. Run it when the prompt, the schema or
 * the model changes.
 *
 *   npm run strategy:contract:live -- [evidence_led|exploratory]
 *
 * GEMINI_API_KEY is read from .env.worker, .env.vercel or the environment.
 *
 * The manifest below is synthetic. Production account content, identifiers and
 * transcripts are prohibited in contract fixtures.
 */

const host = "https://generativelanguage.googleapis.com";

function required(value: string | undefined, message: string): string {
  if (!value) {
    console.error(message);
    exit(1);
  }

  return value;
}

const apiKey = required(env["GEMINI_API_KEY"], "GEMINI_API_KEY is required.");
const mode: StrategyMode = argv[2] === "exploratory" ? "exploratory" : "evidence_led";

/**
 * Which population and period the manifest describes.
 *
 * Only the scope `renderStrategyManifest` states in its header; the versions and
 * the run belong to the manifest hash, which a live proof never computes.
 */
const identity = {
  ageWindow: "day_30",
  instagramAccountId: "studio_parallel_synthetic",
  primaryMetric: "engagement_rate_reach",
  publishedFrom: "2026-05-01",
  publishedTo: "2026-07-31",
} as const;

/**
 * A bounded synthetic manifest covering every rule the validator enforces
 * against the model: a supporting statistic, relevant post evidence, a
 * counterexample that may not be dropped, and a data-quality item that must
 * reach the limitations.
 *
 * These are frozen entries rather than the shape the validator checks against,
 * because the entry is what the product holds and renders from — the validator's
 * view is projected off it below. Written in the product's own key and ordering
 * conventions, so the text this proof sends differs from a real request only in
 * the evidence being invented.
 *
 * `postIds` are distinct throughout: nothing here is meant to look like one
 * observation selected twice. `allowedNumericClaims` is carried for provenance
 * only, as it is on a real row; no rule reads it any more.
 */
const entries: readonly StrategyEvidenceEntry[] = [
  {
    allowedNumericClaims: ["18", "12%"],
    allowedRoles: ["supporting"],
    category: "positive_statistic",
    classification: "moderate_association",
    dimensions: ["hook"],
    evidenceKey: "stat_pos_0",
    evidenceType: "feature_statistic",
    postIds: ["post-a", "post-b"],
    rank: 0,
    rankScore: 0.12,
    referenceId: "stat-hook-question",
    requiredInLimitations: false,
    retrievalReason: "moderate_association",
    sampleSize: 18,
    summaryText:
      "hook=question on engagement_rate_reach: 12% vs comparison; group 18, comparison 24. Question-style hooks appear associated with higher engagement rate on reach in this account and period.",
  },
  {
    allowedNumericClaims: ["9"],
    allowedRoles: ["supporting"],
    category: "positive_statistic",
    classification: "weak_directional_signal",
    dimensions: ["duration"],
    evidenceKey: "stat_pos_1",
    evidenceType: "feature_statistic",
    postIds: ["post-c"],
    rank: 1,
    rankScore: 0.04,
    referenceId: "stat-duration-short",
    requiredInLimitations: false,
    retrievalReason: "weak_directional_signal",
    sampleSize: 9,
    summaryText:
      "duration=short on engagement_rate_reach: 4% vs comparison; group 9, comparison 21. Shorter videos show a directional signal only.",
  },
  {
    allowedNumericClaims: ["5"],
    allowedRoles: ["counterexample"],
    category: "counterexample",
    classification: "weak_directional_signal",
    dimensions: ["hook"],
    evidenceKey: "counter_0",
    evidenceType: "feature_statistic",
    postIds: ["post-d"],
    rank: 0,
    rankScore: 0.03,
    referenceId: "counter-hook-question",
    requiredInLimitations: false,
    retrievalReason: "sensitivity_or_outlier",
    sampleSize: 5,
    summaryText:
      "hook=question on engagement_rate_reach: -3% vs comparison; group 5, comparison 24. A question-hook subgroup that did not show the same association.",
  },
  {
    allowedNumericClaims: [],
    allowedRoles: ["supporting", "context"],
    category: "top_post",
    classification: null,
    dimensions: ["hook"],
    evidenceKey: "post_top_0",
    evidenceType: "post_analysis",
    postIds: ["post-e"],
    rank: 0,
    rankScore: 0.19,
    referenceId: "post-hook-question",
    requiredInLimitations: false,
    retrievalReason: "top_performer",
    sampleSize: null,
    summaryText:
      "published 2026-07-18; pillar process_and_craft; format reel; hook question. A recent post opening on a direct question.",
  },
  {
    allowedNumericClaims: [],
    allowedRoles: ["supporting", "context"],
    category: "top_post",
    classification: null,
    dimensions: ["duration"],
    evidenceKey: "post_top_1",
    evidenceType: "post_analysis",
    postIds: ["post-f"],
    rank: 1,
    rankScore: 0.16,
    referenceId: "post-duration-short",
    requiredInLimitations: false,
    retrievalReason: "top_performer",
    sampleSize: null,
    summaryText:
      "published 2026-07-11; pillar process_and_craft; format reel; hook statement. A recent short video.",
  },
  {
    allowedNumericClaims: [],
    allowedRoles: ["supporting", "context"],
    category: "recent_post",
    classification: null,
    dimensions: ["content_pillar"],
    evidenceKey: "post_recent_0",
    evidenceType: "post_analysis",
    postIds: ["post-g"],
    rank: 0,
    rankScore: 0,
    referenceId: "post-pillar-process",
    requiredInLimitations: false,
    retrievalReason: "most_recent",
    sampleSize: null,
    summaryText:
      "published 2026-07-29; pillar process_and_craft; format reel; hook demonstration. A recent process-and-craft post.",
  },
  {
    allowedNumericClaims: ["6"],
    allowedRoles: ["limitation"],
    category: "data_quality",
    classification: null,
    dimensions: [],
    evidenceKey: "quality_0",
    evidenceType: "data_quality",
    postIds: [],
    rank: 0,
    rankScore: null,
    referenceId: null,
    requiredInLimitations: true,
    retrievalReason: "coverage_gap",
    sampleSize: null,
    summaryText:
      "6 posts have no comparable snapshot inside the requested age window, so they are absent from every comparison above.",
  },
];

/**
 * The validator's view of the same rows.
 *
 * Projected rather than written out a second time, so the manifest the model is
 * shown and the manifest the response is held to cannot disagree — which is the
 * whole property this proof exists to test.
 */
const manifest = entries.map(toStrategyManifestEvidence);

async function main(): Promise<void> {
  console.log(`model: ${strategyModelRequested}`);
  console.log(`mode:  ${mode}`);

  const startedAt = Date.now();

  const response = await fetch(
    `${host}/v1beta/models/${strategyModelRequested}:generateContent?key=${apiKey}`,
    {
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: renderStrategyManifest(identity, entries) },
              { text: createStrategyInstruction({ mode }) },
            ],
            role: "user",
          },
        ],
        generationConfig: { maxOutputTokens: 32_000, responseMimeType: "application/json" },
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    },
  );

  const body = (await response.json()) as {
    candidates?: readonly {
      content?: { parts?: readonly { text?: string }[] };
      finishReason?: string;
    }[];
    error?: { message?: string; status?: string };
    usageMetadata?: Record<string, unknown>;
  };

  if (body.error) {
    console.error(`\nREJECTED ${body.error.status ?? ""}: ${body.error.message ?? ""}`);
    exit(1);
  }

  const candidate = body.candidates?.[0];
  console.log(`accepted in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`finishReason: ${candidate?.finishReason ?? "unknown"}`);
  console.log(`usage: ${JSON.stringify(body.usageMetadata)}`);

  let parsed: unknown;

  try {
    parsed = JSON.parse(candidate?.content?.parts?.[0]?.text ?? "");
  } catch {
    console.error("\nThe response was not JSON.");
    exit(1);
  }

  const stamped = completeStrategyV1(parsed, { mode });
  const verdict = validateStrategyV1(stamped, { manifest, mode });

  console.log(`\ncontract valid: ${verdict.valid}`);

  if (!verdict.valid) {
    for (const issue of verdict.issues) {
      console.error(`  ${issue.code} ${issue.path}`);
    }

    exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  exit(1);
});
