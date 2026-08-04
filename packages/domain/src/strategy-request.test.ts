import { describe, expect, it } from "vitest";

import {
  createStrategyManifestHash,
  createStrategyRequestSignature,
  evaluateStrategyEligibility,
  renderStrategyManifest,
  selectStrategyEvidence,
  strategyEligibilityThresholds,
  strategyEvidenceCaps,
  strategyEvidenceCategories,
  strategyGenerateKey,
  strategyManifestCaps,
  toStrategyManifestEvidence,
  type StrategyEligibilityInput,
  type StrategyEvidenceCandidate,
  type StrategyEvidenceCategory,
  type StrategyManifestIdentity,
} from "./strategy-request.js";

function candidate(
  overrides: Partial<StrategyEvidenceCandidate> & Pick<StrategyEvidenceCandidate, "referenceId">,
): StrategyEvidenceCandidate {
  return {
    allowedNumericClaims: [],
    allowedRoles: ["supporting"],
    category: "positive_statistic",
    classification: "moderate_association",
    dimensions: ["hook"],
    evidenceType: "feature_statistic",
    postIds: [],
    rankScore: 1,
    requiredInLimitations: false,
    retrievalReason: "highest_confidence",
    sampleSize: 12,
    summaryText: `summary ${overrides.referenceId ?? "x"}`,
    ...overrides,
  };
}

function post(
  referenceId: string,
  overrides: Partial<StrategyEvidenceCandidate> = {},
): StrategyEvidenceCandidate {
  return candidate({
    category: "top_post",
    classification: null,
    evidenceType: "post",
    postIds: [referenceId],
    referenceId,
    sampleSize: null,
    ...overrides,
  });
}

const identity: StrategyManifestIdentity = {
  ageWindow: "day_30",
  analysisSchemaVersion: "post-creative-analysis-v1.1.0",
  analyticsRunId: "run_1",
  analyticsVersion: "account-analytics-v1.0.0",
  cohortVersion: "account-cohort-v1.0.0",
  editorialConstraint: null,
  formatEmphasis: [],
  instagramAccountId: "account_1",
  mode: "evidence_led",
  pillarEmphasis: [],
  primaryMetric: "engagement_rate_reach",
  publishedFrom: "2026-02-01T00:00:00.000Z",
  publishedTo: "2026-08-01T00:00:00.000Z",
  statisticsVersion: "account-feature-statistic-v1.0.0",
};

function eligibilityInput(
  overrides: Partial<StrategyEligibilityInput> = {},
): StrategyEligibilityInput {
  return {
    acceptExploratory: false,
    activeRunId: "run_1",
    analysedPostCount: 20,
    analyticsDirty: false,
    comparablePostCount: 16,
    instagramAccountId: "account_1",
    primaryMetric: "engagement_rate_reach",
    publicationWeekCount: 8,
    ...overrides,
  };
}

describe("strategy eligibility", () => {
  it("is evidence-led when every threshold is met", () => {
    expect(evaluateStrategyEligibility(eligibilityInput())).toEqual({
      eligible: true,
      mode: "evidence_led",
    });
  });

  it("refuses an account with nothing analysed rather than calling the model", () => {
    // A new account is a normal empty state, not a failure, and there is nothing
    // for a model to interpret.
    expect(evaluateStrategyEligibility(eligibilityInput({ analysedPostCount: 0 }))).toMatchObject({
      eligible: false,
      reason: "no_analysed_posts",
    });
  });

  it("refuses a metric that has no comparable values behind it", () => {
    // The contract's canonical metrics are wider than the derived metrics a
    // statistic can exist for. Accepting `views` would freeze an empty manifest.
    expect(evaluateStrategyEligibility(eligibilityInput({ primaryMetric: "views" }))).toMatchObject(
      {
        eligible: false,
        reason: "metric_not_comparable",
      },
    );
  });

  it("refuses while a recalculation is owed", () => {
    // The active statistics already describe inputs that moved.
    expect(evaluateStrategyEligibility(eligibilityInput({ analyticsDirty: true }))).toMatchObject({
      eligible: false,
      reason: "stale_calculation",
    });
  });

  it("refuses when there is no published calculation to read", () => {
    expect(evaluateStrategyEligibility(eligibilityInput({ activeRunId: null }))).toMatchObject({
      eligible: false,
      reason: "no_active_calculation",
    });
  });

  it("makes a thin account exploratory only when that is confirmed", () => {
    const thin = eligibilityInput({
      analysedPostCount: strategyEligibilityThresholds.analyses - 1,
      comparablePostCount: 4,
      publicationWeekCount: 2,
    });

    // Never a silent downgrade: the user has to accept that the result cannot
    // speak in supported terms.
    expect(evaluateStrategyEligibility(thin)).toMatchObject({
      eligible: false,
      mode: "exploratory",
      reason: "exploratory_not_confirmed",
    });
    expect(evaluateStrategyEligibility({ ...thin, acceptExploratory: true })).toEqual({
      eligible: true,
      mode: "exploratory",
    });
  });

  it("treats each threshold as independently binding", () => {
    for (const overrides of [
      { analysedPostCount: strategyEligibilityThresholds.analyses - 1 },
      { comparablePostCount: strategyEligibilityThresholds.comparablePosts - 1 },
      { publicationWeekCount: strategyEligibilityThresholds.publicationWeeks - 1 },
    ]) {
      expect(
        evaluateStrategyEligibility(eligibilityInput({ ...overrides, acceptExploratory: true })),
      ).toEqual({ eligible: true, mode: "exploratory" });
    }
  });
});

describe("strategy evidence selection", () => {
  it("writes the manifest in category precedence order", () => {
    const selection = selectStrategyEvidence([
      post("p1", { category: "recent_post" }),
      candidate({ referenceId: "s1" }),
      post("p2"),
    ]);

    expect(selection.entries.map((entry) => entry.category)).toEqual([
      "positive_statistic",
      "top_post",
      "recent_post",
    ]);
  });

  it("orders within a category by score and breaks ties on the reference", () => {
    const selection = selectStrategyEvidence([
      candidate({ rankScore: 5, referenceId: "s_b" }),
      candidate({ rankScore: 9, referenceId: "s_c" }),
      candidate({ rankScore: 5, referenceId: "s_a" }),
    ]);

    expect(selection.entries.map((entry) => entry.referenceId)).toEqual(["s_c", "s_a", "s_b"]);
  });

  it("does not depend on the order candidates were assembled in", () => {
    const built = [
      candidate({ rankScore: 3, referenceId: "s1" }),
      candidate({ rankScore: 3, referenceId: "s2" }),
      post("p1"),
      post("p2"),
    ];

    const forwards = selectStrategyEvidence(built);
    const backwards = selectStrategyEvidence([...built].reverse());

    expect(forwards.entries.map((entry) => entry.evidenceKey)).toEqual(
      backwards.entries.map((entry) => entry.evidenceKey),
    );
    expect(createStrategyManifestHash(identity, forwards.entries)).toBe(
      createStrategyManifestHash(identity, backwards.entries),
    );
  });

  it("enforces every per-category cap", () => {
    const oversubscribed = strategyEvidenceCategories.flatMap((category) =>
      Array.from({ length: strategyEvidenceCaps[category] + 3 }, (_unused, index) =>
        candidate({
          category,
          evidenceType: "data_quality",
          referenceId: `${category}_${String(index)}`,
        }),
      ),
    );

    const selection = selectStrategyEvidence(oversubscribed, { tokenBudget: 1_000_000 });
    const counts = new Map<StrategyEvidenceCategory, number>();
    for (const entry of selection.entries) {
      counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
    }

    for (const category of strategyEvidenceCategories) {
      expect(counts.get(category)).toBe(strategyEvidenceCaps[category]);
    }
  });

  it("keeps a record once when two categories both select it", () => {
    const selection = selectStrategyEvidence([
      candidate({ referenceId: "s1" }),
      candidate({ category: "negative_statistic", referenceId: "s1" }),
    ]);

    // The earlier category wins, so the same statistic cannot read as two.
    expect(selection.entries).toHaveLength(1);
    expect(selection.entries[0]?.category).toBe("positive_statistic");
    expect(selection.trimmed).toContain("negative_statistic");
  });

  it("drops a post already carried by a selected statistic", () => {
    const selection = selectStrategyEvidence([
      candidate({ postIds: ["p1", "p2"], referenceId: "s1" }),
      post("p1"),
      post("p3"),
    ]);

    // One observation must not appear as two pieces of agreement.
    expect(selection.entries.map((entry) => entry.referenceId)).toEqual(["s1", "p3"]);
  });

  it("bounds the manifest by the global post cap", () => {
    const many = Array.from({ length: strategyManifestCaps.posts + 10 }, (_unused, index) =>
      post(`p${String(index)}`, {
        category: index % 2 === 0 ? "top_post" : "recent_post",
        rankScore: index,
      }),
    );

    const selection = selectStrategyEvidence(many, { tokenBudget: 1_000_000 });
    const postCount = selection.entries.filter((entry) => entry.evidenceType === "post").length;

    expect(postCount).toBeLessThanOrEqual(strategyManifestCaps.posts);
  });

  it("trims whole categories from the back when the budget bites", () => {
    const selection = selectStrategyEvidence(
      [
        candidate({ referenceId: "s1", summaryText: "x".repeat(300) }),
        post("p1", { summaryText: "y".repeat(300) }),
      ],
      { tokenBudget: 120 },
    );

    // The lowest-precedence category goes first, so the loss is explainable.
    expect(selection.entries.map((entry) => entry.category)).toEqual(["positive_statistic"]);
    expect(selection.trimmed).toContain("top_post");
  });

  it("reports nothing trimmed when everything fits", () => {
    const selection = selectStrategyEvidence([candidate({ referenceId: "s1" })]);

    expect(selection.trimmed).toEqual([]);
  });

  it("numbers evidence keys per category from zero", () => {
    const selection = selectStrategyEvidence([
      candidate({ rankScore: 2, referenceId: "s1" }),
      candidate({ rankScore: 1, referenceId: "s2" }),
      post("p1"),
    ]);

    expect(selection.entries.map((entry) => entry.evidenceKey)).toEqual([
      "stat_pos_0",
      "stat_pos_1",
      "post_top_0",
    ]);
  });

  it("produces evidence keys the contract accepts", () => {
    const selection = selectStrategyEvidence(
      strategyEvidenceCategories.map((category) =>
        candidate({ category, evidenceType: "data_quality", referenceId: category }),
      ),
    );

    for (const entry of selection.entries) {
      expect(entry.evidenceKey).toMatch(/^[A-Za-z0-9_-]{1,80}$/u);
    }
  });
});

describe("manifest hash and signature", () => {
  const entries = selectStrategyEvidence([candidate({ referenceId: "s1" }), post("p1")]).entries;

  it("is stable across two identical retrievals", () => {
    expect(createStrategyManifestHash(identity, entries)).toBe(
      createStrategyManifestHash(identity, entries),
    );
  });

  it("does not depend on the order emphasis values were supplied in", () => {
    const one = { ...identity, pillarEmphasis: ["process", "education"] };
    const other = { ...identity, pillarEmphasis: ["education", "process"] };

    expect(createStrategyManifestHash(one, entries)).toBe(
      createStrategyManifestHash(other, entries),
    );
  });

  it.each([
    ["mode", { mode: "exploratory" as const }],
    ["metric", { primaryMetric: "save_rate_reach" as const }],
    ["run", { analyticsRunId: "run_2" }],
    ["window", { ageWindow: "mature" }],
    ["period", { publishedTo: "2026-08-02T00:00:00.000Z" }],
    ["constraint", { editorialConstraint: "no discounts" }],
  ])("changes when the %s changes", (_label, overrides) => {
    expect(createStrategyManifestHash({ ...identity, ...overrides }, entries)).not.toBe(
      createStrategyManifestHash(identity, entries),
    );
  });

  it("changes when the evidence changes", () => {
    const other = selectStrategyEvidence([candidate({ referenceId: "s1" })]).entries;

    expect(createStrategyManifestHash(identity, other)).not.toBe(
      createStrategyManifestHash(identity, entries),
    );
  });

  it("separates a regeneration from the request it repeats", () => {
    const hash = createStrategyManifestHash(identity, entries);

    // Without the ordinal an explicit regeneration over unchanged evidence would
    // collapse onto the first generation and return the old answer.
    expect(createStrategyRequestSignature(hash, 1)).not.toBe(
      createStrategyRequestSignature(hash, 0),
    );
    expect(createStrategyRequestSignature(hash, 0)).toBe(createStrategyRequestSignature(hash, 0));
  });

  it("builds a scheduling key the job table accepts", () => {
    const key = strategyGenerateKey(createStrategyManifestHash(identity, entries));

    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/u);
  });
});

describe("manifest rendering", () => {
  it("states each entry as the validator will check it", () => {
    const selection = selectStrategyEvidence([
      candidate({
        allowedNumericClaims: ["1.3x"],
        referenceId: "s1",
        sampleSize: 14,
      }),
    ]);
    const rendered = renderStrategyManifest(identity, selection.entries);

    expect(rendered).toContain("evidenceId=stat_pos_0");
    expect(rendered).toContain("type=feature_statistic");
    expect(rendered).toContain("classification=moderate_association");
    expect(rendered).toContain("sampleSize=14");
    expect(rendered).toContain("allowedNumbersInExplanations=1.3x");
  });

  it("marks evidence the response must acknowledge", () => {
    const selection = selectStrategyEvidence([
      candidate({
        allowedRoles: ["limitation"],
        category: "data_quality",
        classification: null,
        evidenceType: "data_quality",
        referenceId: "q1",
        requiredInLimitations: true,
      }),
    ]);

    expect(renderStrategyManifest(identity, selection.entries)).toContain(
      "mustAppearInLimitations=true",
    );
  });

  it("carries no post text beyond the summary it was given", () => {
    // A manifest is machine input. The fields a human screen shows are not the
    // fields a prompt needs, and a caption is the easiest of them to leak.
    const selection = selectStrategyEvidence([
      post("p1", { summaryText: "pillar=process; format=talking_head; value=0.081" }),
    ]);
    const rendered = renderStrategyManifest(identity, selection.entries);

    expect(rendered).toContain("pillar=process");
    expect(rendered).not.toMatch(/caption/iu);
  });

  it("projects an entry onto the shape the validator consumes", () => {
    const selection = selectStrategyEvidence([candidate({ referenceId: "s1" })]);
    const entry = selection.entries[0];
    if (!entry) throw new Error("expected one entry");

    expect(toStrategyManifestEvidence(entry)).toEqual({
      allowedNumericClaims: [],
      allowedRoles: ["supporting"],
      classification: "moderate_association",
      dimensions: ["hook"],
      evidenceId: "stat_pos_0",
      requiredInLimitations: false,
      sampleSize: 12,
      type: "feature_statistic",
    });
  });
});
