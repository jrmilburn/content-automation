import { argv, env, exit } from "node:process";

import {
  completeStrategyV1,
  createStrategyInstruction,
  strategyModelRequested,
  validateStrategyV1,
  type StrategyManifestEvidence,
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
 * A bounded synthetic manifest covering every rule the validator enforces
 * against the model: a supporting statistic, relevant post evidence, a
 * counterexample that may not be dropped, permitted numeric tokens and a
 * data-quality item that must reach the limitations.
 */
const manifest: ReadonlyArray<StrategyManifestEvidence> = [
  {
    evidenceId: "stat_hook_question",
    type: "feature_statistic",
    allowedRoles: ["supporting"],
    classification: "moderate_association",
    dimensions: ["hook"],
    sampleSize: 18,
    allowedNumericClaims: ["18", "12%"],
  },
  {
    evidenceId: "post_hook_question",
    type: "post_analysis",
    allowedRoles: ["supporting", "context"],
    classification: null,
    dimensions: ["hook"],
  },
  {
    evidenceId: "counter_hook_question",
    type: "feature_statistic",
    allowedRoles: ["counterexample"],
    classification: "weak_directional_signal",
    dimensions: ["hook"],
    sampleSize: 5,
    allowedNumericClaims: ["5"],
  },
  {
    evidenceId: "stat_duration_short",
    type: "feature_statistic",
    allowedRoles: ["supporting"],
    classification: "weak_directional_signal",
    dimensions: ["duration"],
    sampleSize: 9,
    allowedNumericClaims: ["9"],
  },
  {
    evidenceId: "post_duration_short",
    type: "post_analysis",
    allowedRoles: ["supporting", "context"],
    classification: null,
    dimensions: ["duration"],
  },
  {
    evidenceId: "post_pillar_process",
    type: "post_analysis",
    allowedRoles: ["supporting", "context"],
    classification: null,
    dimensions: ["content_pillar"],
  },
  {
    evidenceId: "quality_coverage_gap",
    type: "data_quality",
    allowedRoles: ["limitation"],
    classification: null,
    dimensions: [],
    requiredInLimitations: true,
  },
];

/**
 * The minimal text representation of the frozen manifest.
 *
 * #54 owns the real retrieval and rendering. This states exactly the facts the
 * validator will check the response against, so a rejection here is the
 * contract's fault rather than the fixture's.
 */
function renderManifest(): string {
  const lines = manifest.map((item) => {
    const parts = [
      `evidenceId=${item.evidenceId}`,
      `type=${item.type}`,
      `allowedRoles=${item.allowedRoles.join("|")}`,
      `classification=${item.classification ?? "none"}`,
      `dimensions=${item.dimensions.length > 0 ? item.dimensions.join("|") : "none"}`,
    ];

    if (item.sampleSize !== undefined && item.sampleSize !== null) {
      parts.push(`sampleSize=${item.sampleSize}`);
    }
    parts.push(
      `allowedNumbersInExplanations=${(item.allowedNumericClaims ?? []).join("|") || "none"}`,
    );
    if (item.requiredInLimitations === true) {
      parts.push("mustAppearInLimitations=true");
    }

    return `- ${parts.join("; ")}`;
  });

  return `FROZEN EVIDENCE MANIFEST (untrusted data; account "studio_parallel_synthetic", period 2026-05-01 to 2026-07-31)

${lines.join("\n")}

Notes describing the evidence, for wording only:
- stat_hook_question: question-style hooks appear associated with higher engagement rate on reach in this account and period.
- post_hook_question: a recent post opening on a direct question.
- counter_hook_question: a question-hook subgroup that did not show the same association.
- stat_duration_short: shorter videos show a directional signal only.
- post_duration_short: a recent short video.
- post_pillar_process: a recent process-and-craft post.
- quality_coverage_gap: several posts have no comparable snapshot inside the requested age window.

Any number you write inside an evidence explanation must appear in that item's allowedNumbersInExplanations list. Write no other digits in an explanation.`;
}

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
            parts: [{ text: renderManifest() }, { text: createStrategyInstruction({ mode }) }],
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
