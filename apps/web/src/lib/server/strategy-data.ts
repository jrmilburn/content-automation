import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  listInstagramAccountSummaries,
  listStrategyGenerations,
  loadCurrentStrategy,
  loadStrategyGeneration,
  previewStrategyRequest,
  type StrategyDetail,
  type StrategyEvidenceEntry,
  type StrategyRequestPreview,
  type StrategySummary,
} from "@studio-parallel/db";
import { strategyV1Schema } from "@studio-parallel/domain";

import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

/**
 * What the strategy screen needs to show, and to decide what it may offer.
 *
 * The preview is loaded whether or not a strategy exists, because the question
 * "can this account generate one, and would it be evidence-led" has to be
 * answerable before the button is pressed rather than after.
 *
 * Three empty results are kept apart, as on trends: no account connected, an
 * account that cannot generate yet, and an account that could but never has.
 * They lead to three different next actions, and collapsing them would leave a
 * reader pressing a button that cannot work.
 */

export type StrategyAccountOption = Readonly<{ id: string; label: string }>;

export type StrategySnapshot = Readonly<{
  accounts: readonly StrategyAccountOption[];
  /** The strategy the account currently stands behind, if any. */
  current: StrategyDetail | null;
  hasAccount: boolean;
  history: readonly StrategySummary[];
  /** Null when there is no account to preview against. */
  preview: StrategyRequestPreview | null;
  selectedAccountId: string | null;
}>;

const emptySnapshot: StrategySnapshot = Object.freeze({
  accounts: Object.freeze([]),
  current: null,
  hasAccount: false,
  history: Object.freeze([]),
  preview: null,
  selectedAccountId: null,
});

export async function loadStrategySnapshot(now = new Date()): Promise<StrategySnapshot> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testSnapshot();

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);
  const summaries = await listInstagramAccountSummaries(database, context, { now });

  const accounts = Object.freeze(
    summaries.map((summary) =>
      Object.freeze({
        id: summary.accountId,
        label: summary.username ? `@${summary.username}` : "Unnamed account",
      }),
    ),
  );

  const selectedAccountId = accounts[0]?.id ?? null;
  if (selectedAccountId === null) return Object.freeze({ ...emptySnapshot, accounts });

  // The preview is what tells the screen whether to offer generation at all,
  // and in which mode, so it is never skipped on the strength of an existing
  // strategy: evidence moves under a strategy that has already been written.
  const [current, history, preview] = await Promise.all([
    loadCurrentStrategy(database, context, selectedAccountId),
    listStrategyGenerations(database, context, { instagramAccountId: selectedAccountId }),
    previewStrategyRequest(database, context, {
      acceptExploratory: true,
      instagramAccountId: selectedAccountId,
      primaryMetric: "engagement_rate_reach",
    }),
  ]);

  return Object.freeze({
    accounts,
    current,
    hasAccount: true,
    history,
    preview,
    selectedAccountId,
  });
}

/**
 * One generation by id, for the detail route.
 *
 * Returns null for a missing strategy and for another workspace's alike, so a
 * crafted id cannot be told apart from one that does not exist.
 */
export async function loadStrategyDetail(strategyId: string): Promise<StrategyDetail | null> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") {
    const snapshot = await testSnapshot();
    return snapshot.current?.summary.id === strategyId ? snapshot.current : null;
  }

  return loadStrategyGeneration(
    getDatabase(),
    createWorkspaceContext(principal.workspaceId),
    strategyId,
  );
}

/**
 * A deterministic strategy for browser and accessibility runs.
 *
 * Exercises every section, both classifications a claim may carry and the
 * limitation path, so a run against a database that has never generated one
 * still covers what a reader sees.
 */
async function testSnapshot(): Promise<StrategySnapshot> {
  const testAccountId = "019a0000-0000-7000-8000-000000000301";
  const summary: StrategySummary = Object.freeze({
    analysedPostCount: 24,
    comparablePostCount: 20,
    evidenceCount: 14,
    failureCode: null,
    generatedAt: "2026-08-04T02:00:00.000Z",
    id: "019a0000-0000-7000-8000-0000000005a1",
    instagramAccountId: testAccountId,
    mode: "evidence_led",
    primaryMetric: "engagement_rate_reach",
    publicationWeekCount: 9,
    publishedFrom: "2026-02-04T00:00:00.000Z",
    publishedTo: "2026-08-04T00:00:00.000Z",
    regenerationOrdinal: 0,
    requestedAt: "2026-08-04T01:55:00.000Z",
    state: "SUCCEEDED",
  });

  const evidence = [
    {
      evidenceId: "stat_pos_0",
      explanation: "Question hooks compared against other known hook types.",
      role: "supporting",
    },
  ];

  // One entry resolves to the trend it came from and one is cited without a
  // link, so a browser run covers both. `stat_pos_9` is deliberately absent
  // from the manifest: it is the tombstone case, and it only appears if a
  // limitation cites it.
  const manifest: readonly StrategyEvidenceEntry[] = Object.freeze([
    Object.freeze({
      category: "positive_statistic",
      evidenceKey: "stat_pos_0",
      evidenceType: "feature_statistic",
      referenceId: "019a0000-0000-7000-8000-000000000901",
      summaryText: "Question hooks against other hook types, twelve posts to eight.",
    }),
    Object.freeze({
      category: "data_quality",
      evidenceKey: "quality_0",
      evidenceType: "data_quality",
      referenceId: null,
      summaryText: "Four of twenty-four analysed posts had no comparable value.",
    }),
  ]);

  // Parsed rather than asserted. A fixture that drifts from the contract would
  // otherwise let the browser run pass against a shape the real screen can never
  // receive, which is the whole failure mode a fixture is supposed to avoid.
  const strategy = strategyV1Schema.parse({
    limitations: [
      {
        evidence: [{ evidenceId: "quality_0", explanation: "Coverage note.", role: "supporting" }],
        text: "Four of the twenty-four analysed posts had no comparable value for this metric.",
      },
      {
        evidence: [
          { evidenceId: "stat_pos_9", explanation: "No longer available.", role: "supporting" },
        ],
        text: "One comparison this strategy leaned on is no longer in the manifest.",
      },
    ],
    mode: "evidence_led",
    periodSummary: "Six months of Reels, weighted toward process and craft.",
    pillarPlan: [
      {
        allocationPercent: 100,
        classification: "moderate_association",
        evidence,
        experimental: false,
        pillar: "process_and_craft",
        rationale: "The pillar with the most comparable posts in this period.",
      },
    ],
    recommendations: [
      {
        classification: "creative_recommendation",
        contentPillar: "process_and_craft",
        creativeLeap: null,
        cta: { text: "Follow for the next build", type: "follow" },
        editingApproach: ["Cut on action"],
        evidence,
        experiment: {
          decisionRule: "Keep if engagement rate on reach beats the account median.",
          evidence,
          hypothesis: "A question hook raises engagement rate on reach.",
          minimumPosts: 6,
          observationWindow: "30d",
          primaryMetric: "engagement_rate_reach",
          variableToChange: "Opening hook",
          variablesToHoldStable: ["Pillar", "Duration band"],
        },
        filmingApproach: ["Single setup, close framing"],
        format: "behind_the_scenes",
        hookOptions: [
          "What breaks first on a rushed build?",
          "Why did this joint fail?",
          "Would you have caught this?",
        ],
        intendedAudience: "Studio owners planning a fit-out",
        iterationReason: null,
        key: "rec_0",
        rationale: "Extends the pattern with the strongest evidence in this period.",
        structure: [
          { purpose: "Ask the question", section: "Hook", suggestedSeconds: 3 },
          { purpose: "Show the failure", section: "Body", suggestedSeconds: 20 },
        ],
        title: "Show the joint that failed",
        topic: "Build failures",
      },
    ],
    schemaVersion: "account-content-strategy-v1.0.0",
    testsNext: [
      {
        decisionRule: "Keep if the median beats the account median over six posts.",
        evidence,
        hypothesis: "Opening on a direct question raises engagement rate on reach.",
        minimumPosts: 6,
        observationWindow: "30d",
        primaryMetric: "engagement_rate_reach",
        variableToChange: "Opening hook",
        variablesToHoldStable: ["Pillar", "Duration band"],
      },
    ],
    title: "Lead with the question, keep the build visible",
    weakPatterns: [
      {
        classification: "single_post_outlier",
        dimension: "format",
        evidence,
        key: "weak_0",
        sampleSize: 1,
        statement: "One announcement post carried the whole difference for its format.",
        whyItMatters: "A single post cannot support a change in what gets made.",
      },
    ],
    workingPatterns: [
      {
        classification: "moderate_association",
        dimension: "hook",
        evidence,
        key: "work_0",
        sampleSize: 12,
        statement: "Question hooks appear associated with higher engagement rate on reach.",
        whyItMatters: "It is the clearest lever in this period and cheap to apply.",
      },
    ],
  });

  return Object.freeze({
    accounts: Object.freeze([Object.freeze({ id: testAccountId, label: "@studioparallel" })]),
    current: Object.freeze({
      analyticsVersion: "account-analytics-v1.0.0",
      evidence: manifest,
      modelVersion: "gemini-3.6-flash",
      statisticsVersion: "account-feature-statistic-v1.0.0",
      strategy,
      strategySchemaVersion: "account-content-strategy-v1.0.0",
      summary,
    }),
    hasAccount: true,
    history: Object.freeze([summary]),
    preview: Object.freeze({
      ageWindow: "day_30",
      analysedPostCount: 24,
      comparablePostCount: 20,
      mode: "evidence_led" as const,
      publicationWeekCount: 9,
      publishedFrom: "2026-02-04T00:00:00.000Z",
      publishedTo: "2026-08-04T00:00:00.000Z",
      reason: null,
    }),
    selectedAccountId: testAccountId,
  });
}
