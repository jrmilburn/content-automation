// @vitest-environment jsdom
import type { TrendContributor, TrendDetail, TrendListItem } from "@studio-parallel/db";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TrendsSnapshot } from "../lib/server/trends-data";
import type { TrendsFilterValues } from "../lib/trends";
import { TrendDetailScreen, TrendsError, TrendsScreen } from "./trends";

const accountId = "019a0000-0000-7000-8000-000000000301";
const runId = "019a0000-0000-7000-8000-000000000801";
const publishedRecently = new Date(Date.now() - 60 * 60 * 1_000).toISOString();

function trend(overrides: Partial<TrendListItem> = {}): TrendListItem {
  return {
    ageWindow: "day_30",
    classificationReason: "meets_supported_thresholds",
    comparisonCount: 24,
    comparisonIqr: 0.01,
    comparisonMedian: 0.04,
    confidence: "statistically_supported_association",
    differenceOfMedians: 0.02,
    distinctPublicationDates: 12,
    distinctPublicationWeeks: 7,
    featurePath: "content.hook.category",
    featureValue: "question",
    groupCount: 12,
    groupIqr: 0.015,
    groupMedian: 0.06,
    id: "019a0000-0000-7000-8000-000000000901",
    intervalConfidence: 0.95,
    intervalLower: 0.008,
    intervalUpper: 0.031,
    metric: "engagement_rate_reach",
    missingRatio: 0.03,
    multipleTestingApplied: true,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: 0.5,
    sensitivityHoldsDirection: true,
    topContributorShare: null,
    ...overrides,
  };
}

function calculation(overrides: Record<string, unknown> = {}) {
  return {
    activatedAt: publishedRecently,
    ageWindow: "day_30",
    analysisCount: 45,
    analyticsVersion: "account-analytics-v1.0.0",
    durationMs: 8_400,
    id: runId,
    instagramAccountId: accountId,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    statisticCount: 1,
    statisticsVersion: "account-statistics-v1.0.0",
    ...overrides,
  };
}

function values(overrides: Partial<TrendsFilterValues> = {}): TrendsFilterValues {
  return { account: "", confidence: "all", feature: "", metric: "all", ...overrides };
}

function snapshot(overrides: Partial<TrendsSnapshot> = {}): TrendsSnapshot {
  return {
    accountDefaulted: false,
    accounts: [{ id: accountId, label: "@studioparallel" }],
    featurePaths: ["content.hook.category"],
    hasAccount: true,
    list: {
      calculation: calculation(),
      generatedAt: "2026-08-03T06:00:00.000Z",
      trends: [trend()],
    },
    pooled: false,
    pooledAvailable: false,
    selectedAccountId: accountId,
    ...overrides,
  };
}

/** The same workspace once its pooled calculation has published. */
function pooledSnapshot(overrides: Partial<TrendsSnapshot> = {}): TrendsSnapshot {
  const second = "019a0000-0000-7000-8000-000000000302";

  return snapshot({
    accounts: [
      { id: accountId, label: "@studioparallel" },
      { id: second, label: "@parallelstudio" },
    ],
    list: {
      calculation: calculation({ instagramAccountId: null }),
      generatedAt: "2026-08-03T06:00:00.000Z",
      trends: [trend({ classificationReason: "meets_moderate_thresholds" })],
    },
    pooled: true,
    pooledAvailable: true,
    selectedAccountId: null,
    ...overrides,
  });
}

function contributor(overrides: Partial<TrendContributor> = {}): TrendContributor {
  return {
    caption: "Three lighting mistakes that flatten a product shot.",
    instagramPostId: "019a0000-0000-7000-8000-000000000410",
    membership: "group",
    permalink: "https://www.instagram.com/reel/abc123/",
    postAnalysisId: "019a0000-0000-7000-8000-000000000420",
    publishedAt: "2026-06-02T00:00:00.000Z",
    value: 0.061,
    ...overrides,
  };
}

function detail(overrides: Partial<TrendDetail> = {}): TrendDetail {
  return {
    calculation: calculation(),
    contributors: [contributor(), contributor({ membership: "comparison", value: 0.039 })],
    trend: trend(),
    ...overrides,
  };
}

describe("TrendsScreen", () => {
  it("shows every fact a reader needs to judge a comparison", () => {
    // The acceptance criteria list these together because any one of them
    // missing lets the number be read as stronger than it is.
    render(<TrendsScreen snapshot={snapshot()} values={values()} />);

    const card = screen.getByRole("article", { name: /Hook type: Question/u });

    expect(within(card).getByText("Hook type: Question")).toBeTruthy();
    expect(within(card).getByText("Engagement rate (per reach)")).toBeTruthy();
    expect(within(card).getByText("+50%")).toBeTruthy();
    expect(within(card).getByText(/12 with this value, 24 compared against/u)).toBeTruthy();
    expect(within(card).getByText("Statistically supported")).toBeTruthy();
  });

  it("names the denominator alongside the metric", () => {
    // follow_rate_reach and follow_conversion_rate share a numerator and answer
    // different questions, so a bare metric name is ambiguous between them.
    render(<TrendsScreen snapshot={snapshot()} values={values()} />);

    expect(screen.getByText("Engagement rate (per reach)")).toBeTruthy();
  });

  it("renders every section even when a section is empty", () => {
    render(
      <TrendsScreen
        snapshot={snapshot({
          list: {
            calculation: calculation(),
            generatedAt: "2026-08-03T06:00:00.000Z",
            trends: [trend({ confidence: "single_post_outlier" })],
          },
        })}
        values={values()}
      />,
    );

    for (const heading of [
      "Supported associations",
      "Directional signals",
      "Outliers and counterexamples",
      "Not enough evidence",
    ]) {
      expect(screen.getByRole("region", { name: heading })).toBeTruthy();
    }
  });

  it("keeps an outlier inspectable rather than folding it into a claim", () => {
    render(
      <TrendsScreen
        snapshot={snapshot({
          list: {
            calculation: calculation(),
            generatedAt: "2026-08-03T06:00:00.000Z",
            trends: [trend({ confidence: "single_post_outlier", topContributorShare: 0.72 })],
          },
        })}
        values={values()}
      />,
    );

    const section = screen.getByRole("region", { name: "Outliers and counterexamples" });

    expect(within(section).getByText("Single-post outlier")).toBeTruthy();
    expect(within(section).getByText(/Driven by a single post/u)).toBeTruthy();
    expect(within(section).getByRole("link", { name: /See the evidence/u })).toBeTruthy();
  });

  it("says the calculation is behind when it has fallen behind", () => {
    const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString();

    render(
      <TrendsScreen
        snapshot={snapshot({
          list: {
            calculation: calculation({ activatedAt: stale }),
            generatedAt: "2026-08-03T06:00:00.000Z",
            trends: [trend()],
          },
        })}
        values={values()}
      />,
    );

    expect(screen.getByText("Calculation is behind")).toBeTruthy();
    expect(screen.getByText(/not included yet/u)).toBeTruthy();
  });

  it("separates never calculated from filtered to nothing", () => {
    const empty = {
      calculation: null,
      generatedAt: "2026-08-03T06:00:00.000Z",
      trends: [] as readonly TrendListItem[],
    };

    const { unmount } = render(
      <TrendsScreen snapshot={snapshot({ list: empty })} values={values()} />,
    );
    expect(screen.getByText("Nothing has been calculated yet")).toBeTruthy();
    unmount();

    render(
      <TrendsScreen
        snapshot={snapshot({
          list: { ...empty, calculation: calculation({ statisticCount: 0 }) },
        })}
        values={values({ metric: "save_rate_reach" })}
      />,
    );

    // "No comparisons match these filters" is not a finding of no pattern, and
    // the copy has to say so or a filtered screen reads as a conclusion.
    expect(screen.getByText("No comparisons match these filters")).toBeTruthy();
    expect(screen.getByText(/not a finding that no pattern exists/u)).toBeTruthy();
  });

  it("names the account every figure belongs to", () => {
    render(<TrendsScreen snapshot={snapshot()} values={values()} />);

    expect(screen.getByText(/Showing @studioparallel/u)).toBeTruthy();
  });

  it("says a pooled screen is every linked account rather than naming one", () => {
    render(<TrendsScreen snapshot={pooledSnapshot()} values={values()} />);

    expect(screen.getByText(/Showing every linked account together/u)).toBeTruthy();
    expect(screen.getByText(/@studioparallel, @parallelstudio/u)).toBeTruthy();
    expect(screen.getByText(/nothing below is a finding about a single account/u)).toBeTruthy();
  });

  it("never claims a pooled comparison is this account's history", () => {
    // The card's claim is the sentence a reader quotes, and the same evidence
    // class means something different across two audiences than within one.
    render(<TrendsScreen snapshot={pooledSnapshot()} values={values()} />);

    const card = screen.getByRole("article", { name: /Hook type: Question/u });

    expect(within(card).getByText(/across the linked accounts/u)).toBeTruthy();
    expect(within(card).queryByText(/in this account/u)).toBeNull();
    expect(screen.queryByText(/What this account's own history shows/u)).toBeNull();
  });

  it("offers the pooled scope only once a pooled calculation has published", () => {
    const { unmount } = render(<TrendsScreen snapshot={pooledSnapshot()} values={values()} />);

    const offered = screen.getByLabelText<HTMLSelectElement>("Account");
    // An unstated scope resolves to pooled, so the control has to show that as
    // selected rather than leaving a blank select above pooled figures.
    expect(offered.value).toBe("all");
    expect(within(offered).getByRole("option", { name: "All linked accounts" })).toBeTruthy();
    unmount();

    render(
      <TrendsScreen
        snapshot={pooledSnapshot({ pooled: false, pooledAvailable: false })}
        values={values()}
      />,
    );

    expect(
      within(screen.getByLabelText("Account")).queryByRole("option", {
        name: "All linked accounts",
      }),
    ).toBeNull();
  });

  it("says when the account was defaulted rather than chosen", () => {
    const second = "019a0000-0000-7000-8000-000000000302";
    render(
      <TrendsScreen
        snapshot={snapshot({
          accountDefaulted: true,
          accounts: [
            { id: accountId, label: "@studioparallel" },
            { id: second, label: "@parallelstudio" },
          ],
        })}
        values={values()}
      />,
    );

    // The figures are right either way; what would mislead is letting the
    // reader believe they asked for this account.
    expect(screen.getByText(/no account was chosen/u)).toBeTruthy();
  });

  it("lets the account control represent no choice at all", () => {
    const second = "019a0000-0000-7000-8000-000000000302";
    render(
      <TrendsScreen
        snapshot={snapshot({
          accountDefaulted: true,
          accounts: [
            { id: accountId, label: "@studioparallel" },
            { id: second, label: "@parallelstudio" },
          ],
        })}
        values={values()}
      />,
    );

    // Without an empty option the browser marks the first account selected,
    // which reads as a choice the reader never made.
    const account = screen.getByLabelText("Account") as HTMLSelectElement;
    expect(account.value).toBe("");
    expect(within(account).getByRole("option", { name: "No account chosen" })).toBeTruthy();
  });

  it("does not claim a default was applied when the reader named the account", () => {
    render(
      <TrendsScreen
        snapshot={snapshot({ accountDefaulted: false })}
        values={values({ account: accountId })}
      />,
    );

    expect(screen.queryByText(/no account was chosen/u)).toBeNull();
    expect(screen.getByText(/Showing @studioparallel/u)).toBeTruthy();
  });

  it("points an unconnected workspace at the connection rather than at trends", () => {
    render(
      <TrendsScreen
        snapshot={snapshot({
          accounts: [],
          hasAccount: false,
          list: { calculation: null, generatedAt: "2026-08-03T06:00:00.000Z", trends: [] },
          selectedAccountId: null,
        })}
        values={values()}
      />,
    );

    expect(screen.getByText("No Instagram account connected")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Narrow the comparisons" })).toBeNull();
  });

  it("offers only the features the published run produced", () => {
    render(
      <TrendsScreen
        snapshot={snapshot({ featurePaths: ["content.durationBand"] })}
        values={values()}
      />,
    );

    const feature = screen.getByLabelText("Feature");

    expect(within(feature).getByRole("option", { name: "Duration" })).toBeTruthy();
    expect(within(feature).queryByRole("option", { name: "Hook type" })).toBeNull();
  });

  it("keeps the applied filters in the form so the URL and the controls agree", () => {
    render(
      <TrendsScreen
        snapshot={snapshot()}
        values={values({ confidence: "weak_directional_signal", metric: "like_rate_reach" })}
      />,
    );

    expect(screen.getByLabelText<HTMLSelectElement>("Metric").value).toBe("like_rate_reach");
    expect(screen.getByLabelText<HTMLSelectElement>("Evidence level").value).toBe(
      "weak_directional_signal",
    );
  });
});

describe("TrendDetailScreen", () => {
  it("gives the table equivalent of the comparison rather than a chart", () => {
    render(<TrendDetailScreen detail={detail()} />);

    const section = screen.getByRole("region", { name: "The comparison" });
    const table = within(section).getByRole("table");

    expect(within(table).getByRole("rowheader", { name: "Posts with Question" })).toBeTruthy();
    expect(within(table).getByRole("rowheader", { name: "Posts with another value" })).toBeTruthy();
    expect(within(table).getByText("6.00%")).toBeTruthy();
  });

  it("shows the formula and denominator the value came from", () => {
    render(<TrendDetailScreen detail={detail()} />);

    const method = screen.getByRole("region", { name: "How it was calculated" });

    expect(within(method).getByText("Metric formula")).toBeTruthy();
    expect(within(method).getByText("reach")).toBeTruthy();
    expect(within(method).getByText(/95% range/u)).toBeTruthy();
  });

  it("explains why a comparison could not be answered, and what would answer it", () => {
    render(
      <TrendDetailScreen
        detail={detail({
          trend: trend({
            classificationReason: "below_minimum_samples",
            confidence: "insufficient_evidence",
            intervalLower: null,
            intervalUpper: null,
          }),
        })}
      />,
    );

    expect(screen.getByText(/Too few posts on one side/u)).toBeTruthy();
    // A dash beside "uncertainty" would let a reader take an uncalculated
    // interval for a precise result.
    expect(screen.getByText(/Not calculated/u)).toBeTruthy();
  });

  it("lists both sides of the comparison, not only the supporting posts", () => {
    render(<TrendDetailScreen detail={detail()} />);

    expect(screen.getByRole("region", { name: "Posts with this value" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Posts compared against" })).toBeTruthy();
  });

  it("names the population a pooled comparison was drawn from", () => {
    // A detail page is reachable by its own URL with no snapshot behind it, so
    // the run it was published in is the only thing that can say whose history
    // this is.
    render(
      <TrendDetailScreen
        detail={detail({
          calculation: calculation({ instagramAccountId: null }),
          trend: trend({
            classificationReason: "interval_ignores_clustering",
            confidence: "moderate_association",
          }),
        })}
      />,
    );

    expect(screen.getByText("Every linked account, pooled into one comparison")).toBeTruthy();
    expect(screen.getByText(/across the linked accounts' combined history/u)).toBeTruthy();
    expect(screen.getByText(/Measured across every linked account at once/u)).toBeTruthy();
  });

  it("names a captionless contributor rather than leaving the cell blank", () => {
    render(
      <TrendDetailScreen detail={detail({ contributors: [contributor({ caption: null })] })} />,
    );

    expect(screen.getByText("No caption")).toBeTruthy();
  });
});

describe("TrendsError", () => {
  it("says nothing was changed and gives the reference", () => {
    render(<TrendsError reference="01926f2a-0000-7000-8000-0000000000aa" />);

    expect(screen.getByText("Trends did not load")).toBeTruthy();
    expect(screen.getByText(/Nothing was changed/u)).toBeTruthy();
    expect(screen.getByText(/01926f2a-0000-7000-8000-0000000000aa/u)).toBeTruthy();
  });
});
