// @vitest-environment jsdom
import type { StrategyDetail, StrategyEvidenceEntry, StrategySummary } from "@studio-parallel/db";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StrategySnapshot } from "../lib/server/strategy-data";

// The control reaches a server action, which reaches the session and the
// database. What is under test here is what the screen says, not how the
// request is made, so the boundary is stubbed at the component.
vi.mock("./strategy-request-control", () => ({
  StrategyRequestControl: ({ exploratory }: Readonly<{ exploratory: boolean }>) => (
    <button type="button">
      {exploratory ? "Generate an exploratory strategy" : "Generate a strategy"}
    </button>
  ),
}));

const { StrategyReport, StrategyScreen } = await import("./strategy");

function summary(overrides: Partial<StrategySummary> = {}): StrategySummary {
  return {
    analysedPostCount: 24,
    comparablePostCount: 20,
    evidenceCount: 14,
    failureCode: null,
    generatedAt: "2026-08-04T02:00:00.000Z",
    id: "019a0000-0000-7000-8000-0000000005a1",
    instagramAccountId: "019a0000-0000-7000-8000-000000000301",
    mode: "evidence_led",
    primaryMetric: "engagement_rate_reach",
    publicationWeekCount: 9,
    publishedFrom: "2026-02-04T00:00:00.000Z",
    publishedTo: "2026-08-04T00:00:00.000Z",
    regenerationOrdinal: 0,
    requestedAt: "2026-08-04T01:55:00.000Z",
    state: "SUCCEEDED",
    ...overrides,
  };
}

const evidence = [
  {
    evidenceId: "stat_pos_0",
    explanation: "Question hooks against other hooks.",
    role: "supporting",
  },
];

const manifest: readonly StrategyEvidenceEntry[] = [
  {
    category: "positive_statistic",
    evidenceKey: "stat_pos_0",
    evidenceType: "feature_statistic",
    referenceId: "019a0000-0000-7000-8000-000000000901",
    summaryText: "Question hooks against other hook types.",
  },
  {
    category: "data_quality",
    evidenceKey: "quality_0",
    evidenceType: "data_quality",
    referenceId: null,
    summaryText: "Four posts had no comparable value.",
  },
];

function strategy(overrides: Record<string, unknown> = {}) {
  return {
    limitations: [{ evidence: [], text: "Four posts had no comparable value." }],
    mode: "evidence_led",
    periodSummary: "Six months of Reels.",
    pillarPlan: [
      {
        allocationPercent: 100,
        classification: "moderate_association",
        evidence,
        experimental: false,
        pillar: "process_and_craft",
        rationale: "Most comparable posts.",
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
          decisionRule: "Keep if it beats the median.",
          evidence,
          hypothesis: "A question hook raises engagement.",
          minimumPosts: 6,
          observationWindow: "30d",
          primaryMetric: "engagement_rate_reach",
          variableToChange: "Opening hook",
          variablesToHoldStable: ["Pillar"],
        },
        filmingApproach: ["Single setup"],
        format: "behind_the_scenes",
        hookOptions: ["What breaks first?", "Why did this fail?", "Would you catch this?"],
        intendedAudience: "Studio owners",
        iterationReason: null,
        key: "rec_0",
        rationale: "Extends the strongest pattern.",
        structure: [{ purpose: "Ask", section: "Hook", suggestedSeconds: 3 }],
        title: "Show the joint that failed",
        topic: "Build failures",
      },
    ],
    schemaVersion: "account-content-strategy-v1.0.0",
    testsNext: [
      {
        decisionRule: "Keep if the median beats the account median.",
        evidence,
        hypothesis: "Opening on a question raises engagement.",
        minimumPosts: 6,
        observationWindow: "30d",
        primaryMetric: "engagement_rate_reach",
        variableToChange: "Opening hook",
        variablesToHoldStable: ["Pillar"],
      },
    ],
    title: "Lead with the question",
    weakPatterns: [
      {
        classification: "single_post_outlier",
        dimension: "format",
        evidence,
        key: "weak_0",
        sampleSize: 1,
        statement: "One announcement carried the whole difference.",
        whyItMatters: "A single post cannot support a change.",
      },
    ],
    workingPatterns: [
      {
        classification: "moderate_association",
        dimension: "hook",
        evidence,
        key: "work_0",
        sampleSize: 12,
        statement: "Question hooks appear associated with higher engagement.",
        whyItMatters: "Cheapest lever in this period.",
      },
    ],
    ...overrides,
  };
}

function detail(overrides: Partial<StrategyDetail> = {}): StrategyDetail {
  return {
    analyticsVersion: "account-analytics-v1.0.0",
    evidence: manifest,
    modelVersion: "gemini-3.6-flash",
    statisticsVersion: "account-feature-statistic-v1.0.0",
    strategy: strategy() as StrategyDetail["strategy"],
    strategySchemaVersion: "account-content-strategy-v1.0.0",
    summary: summary(),
    ...overrides,
  };
}

function snapshot(overrides: Partial<StrategySnapshot> = {}): StrategySnapshot {
  return {
    accounts: [{ id: summary().instagramAccountId, label: "@studioparallel" }],
    current: detail(),
    hasAccount: true,
    history: [summary()],
    preview: {
      ageWindow: "day_30",
      analysedPostCount: 24,
      comparablePostCount: 20,
      mode: "evidence_led",
      publicationWeekCount: 9,
      publishedFrom: "2026-02-04T00:00:00.000Z",
      publishedTo: "2026-08-04T00:00:00.000Z",
      reason: null,
    },
    selectedAccountId: summary().instagramAccountId,
    ...overrides,
  };
}

describe("StrategyReport", () => {
  it("orders sections so decisions lead and caveats close", () => {
    // The acceptance criteria fix this order because a reader who stops early
    // must have read the decisions, and one who reads on must reach the
    // limitations before acting.
    render(<StrategyReport detail={detail()} />);

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);

    expect(headings).toEqual([
      "Lead with the question",
      "What is working",
      "What is not working",
      "What to test next",
      "Videos to make next",
      "Where to spend the next posts",
      "What this cannot tell you",
    ]);
  });

  it("keeps the sample size beside the claim it qualifies", () => {
    // Separating them lets a twelve-post association read like a settled fact.
    render(<StrategyReport detail={detail()} />);

    const claim = screen.getByRole("article", {
      name: /Question hooks appear associated/u,
    });

    expect(within(claim).getByText("Appears associated in this account")).toBeTruthy();
    expect(within(claim).getByText("12 posts")).toBeTruthy();
  });

  it("calls a recommendation a creative proposal, never a finding", () => {
    // Ready-to-film ideas are the easiest thing on the page to mistake for
    // evidence, so the label is adjacent rather than in a legend.
    render(<StrategyReport detail={detail()} />);

    const recommendation = screen.getByRole("article", { name: /Show the joint that failed/u });

    expect(within(recommendation).getByText("Creative proposal")).toBeTruthy();
  });

  it("opens the stored evidence behind every empirical claim", () => {
    // The citation is not decoration: it has to reach the trend the claim was
    // computed from, or a reader cannot check it.
    render(<StrategyReport detail={detail()} />);

    const claim = screen.getByRole("article", { name: /Question hooks appear associated/u });
    const citation = within(claim).getByRole("link", { name: "stat_pos_0" });

    expect(citation.getAttribute("href")).toBe("/trends/019a0000-0000-7000-8000-000000000901");
    expect(within(claim).getByText(/Question hooks against other hooks/u)).toBeTruthy();
  });

  it("cites evidence that has no page without inventing a link to one", () => {
    // A data-quality note is synthesised from the sample rather than read from a
    // row, so there is nothing to open. It is still shown.
    render(
      <StrategyReport
        detail={detail({
          strategy: strategy({
            workingPatterns: [
              {
                classification: "moderate_association",
                dimension: "hook",
                evidence: [
                  { evidenceId: "quality_0", explanation: "Coverage.", role: "supporting" },
                ],
                key: "work_0",
                sampleSize: 12,
                statement: "Question hooks appear associated with higher engagement.",
                whyItMatters: "Cheapest lever.",
              },
            ],
          }) as never,
        })}
      />,
    );

    const claim = screen.getByRole("article", { name: /Question hooks appear associated/u });

    expect(within(claim).getByText("quality_0")).toBeTruthy();
    expect(within(claim).queryByRole("link", { name: "quality_0" })).toBeNull();
  });

  it("tombstones evidence that has gone rather than substituting another", () => {
    // Dropping the row, or showing the nearest surviving evidence, would leave
    // the claim looking as well-supported as one whose evidence is still there.
    render(
      <StrategyReport
        detail={detail({
          strategy: strategy({
            workingPatterns: [
              {
                classification: "moderate_association",
                dimension: "hook",
                evidence: [{ evidenceId: "stat_pos_9", explanation: "Gone.", role: "supporting" }],
                key: "work_0",
                sampleSize: 12,
                statement: "Question hooks appear associated with higher engagement.",
                whyItMatters: "Cheapest lever.",
              },
            ],
          }) as never,
        })}
      />,
    );

    const claim = screen.getByRole("article", { name: /Question hooks appear associated/u });

    expect(within(claim).getByText(/no longer available/u)).toBeTruthy();
    expect(within(claim).queryByText(/Question hooks against other hook types/u)).toBeNull();
  });

  it("renders an empty section rather than hiding it", () => {
    // A missing section and an empty one look identical once scrolled, and mean
    // opposite things.
    render(
      <StrategyReport detail={detail({ strategy: strategy({ workingPatterns: [] }) as never })} />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "What is working" })).toBeTruthy();
    expect(screen.getByText(/That is not a finding that nothing works/u)).toBeTruthy();
  });

  it("says an exploratory strategy is not supported evidence", () => {
    render(
      <StrategyReport
        detail={detail({
          strategy: strategy({ mode: "exploratory", workingPatterns: [] }) as never,
          summary: summary({ mode: "exploratory" }),
        })}
      />,
    );

    expect(screen.getByText(/Nothing here is a supported finding/u)).toBeTruthy();
  });

  it("refuses to render a strategy stored under a contract it cannot read", () => {
    // Better a statement a reader can act on than a component failing part-way
    // through a section.
    render(<StrategyReport detail={detail({ strategy: null })} />);

    expect(screen.getByText("This strategy cannot be displayed")).toBeTruthy();
  });
});

describe("StrategyScreen", () => {
  it("shows the period, metric, counts and mode before anything is generated", () => {
    // The preview exists so a reader knows which kind of document they are
    // about to make, rather than discovering it afterwards. The period and the
    // metric are what the counts are counts of; without them "20 comparable
    // posts" names no window and no measure.
    render(<StrategyScreen snapshot={snapshot({ current: null, history: [] })} />);

    const request = screen.getByRole("region", { name: "Generate a strategy" });

    expect(within(request).getByText("4 Feb 2026 to 4 Aug 2026")).toBeTruthy();
    expect(within(request).getByText(/Engagement rate/iu)).toBeTruthy();
    expect(within(request).getByText("24")).toBeTruthy();
    expect(within(request).getByText("20")).toBeTruthy();
    expect(within(request).getByText("Evidence-led")).toBeTruthy();
  });

  it("explains a refusal instead of offering a button that cannot work", () => {
    render(
      <StrategyScreen
        snapshot={snapshot({
          current: null,
          history: [],
          preview: {
            ageWindow: null,
            analysedPostCount: 0,
            comparablePostCount: 0,
            mode: null,
            publicationWeekCount: 0,
            publishedFrom: null,
            publishedTo: null,
            reason: "no_analysed_posts",
          },
        })}
      />,
    );

    expect(screen.getByText(/No posts have been analysed yet/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Generate/u })).toBeNull();
  });

  it("distinguishes no account from nothing generated", () => {
    render(
      <StrategyScreen snapshot={snapshot({ current: null, hasAccount: false, history: [] })} />,
    );

    expect(screen.getByText("No Instagram account connected")).toBeTruthy();
    expect(screen.queryByText("No strategy generated yet")).toBeNull();
  });

  it("keeps a failed request in history without displacing the current one", () => {
    // A failure that hid the strategy a reader was last shown would lose the
    // only thing they could still act on.
    render(
      <StrategyScreen
        snapshot={snapshot({
          history: [
            summary({
              failureCode: "STRATEGY_RESPONSE_INVALID",
              id: "019a0000-0000-7000-8000-0000000005b2",
              state: "FAILED",
            }),
            summary(),
          ],
        })}
      />,
    );

    expect(screen.getByText("Did not complete")).toBeTruthy();
    expect(screen.getByText(/The previous one is unaffected/u)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Lead with the question" })).toBeTruthy();
  });
});
