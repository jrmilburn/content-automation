import type { DerivedMetric } from "@studio-parallel/domain";
import { describe, expect, it } from "vitest";

import {
  buildFeatureRequests,
  type AnalyticsInputPost,
  type AnalyticsInputRequest,
  type AnalyticsInputSet,
} from "./analytics-features.js";

/**
 * Which comparisons a run asks for, and which it refuses to ask pooled.
 *
 * Reading the posts needs a database and is proved in the integration suite.
 * Deciding what may be compared is a judgement over posts already read, and the
 * pooled scope narrows it.
 */

const window = Object.freeze({
  publishedFrom: new Date("2026-01-01T00:00:00.000Z"),
  publishedTo: new Date("2026-07-31T00:00:00.000Z"),
});

function post(
  input: Readonly<{ accountId: string; hookCategory: string; index: number }>,
): AnalyticsInputPost {
  return Object.freeze({
    features: new Map([["content.hook.category", input.hookCategory]]),
    instagramAccountId: input.accountId,
    metricValues: new Map<DerivedMetric, number>([
      ["engagement_count", 100],
      ["engagement_rate_reach", 0.2],
    ]),
    postAnalysisId: `analysis-${String(input.index)}`,
    postId: `post-${String(input.index)}`,
    publishedAt: new Date(Date.UTC(2026, 0, 5 + input.index)).toISOString(),
    snapshotId: `snapshot-${String(input.index)}`,
  });
}

/** Six posts across two accounts, split evenly between two hook categories. */
function inputs(): AnalyticsInputSet {
  const posts = Array.from({ length: 6 }, (_unused, index) =>
    post({
      accountId: index % 2 === 0 ? "account-a" : "account-b",
      hookCategory: index < 3 ? "question" : "statement",
      index,
    }),
  );

  return Object.freeze({
    analysisIds: posts.map((entry) => entry.postAnalysisId),
    posts: Object.freeze(posts),
    snapshotIds: posts.map((entry) => entry.snapshotId),
  });
}

function request(overrides: Partial<AnalyticsInputRequest> = {}): AnalyticsInputRequest {
  return { ageWindow: "day_30", ...window, ...overrides };
}

describe("buildFeatureRequests", () => {
  it("asks about engagement_count for one account", () => {
    const metrics = buildFeatureRequests(
      request({ instagramAccountId: "account-a" }),
      inputs(),
    ).map((family) => family.metric);

    expect(metrics).toContain("engagement_count");
  });

  it("refuses to ask about engagement_count pooled", () => {
    // It is the one derived metric with no denominator, so pooled it measures
    // which account published the post rather than what the post did.
    const metrics = buildFeatureRequests(request(), inputs()).map((family) => family.metric);

    expect(metrics).not.toContain("engagement_count");
    expect(metrics).toContain("engagement_rate_reach");
  });

  it("leaves the account off a pooled family rather than naming one", () => {
    // The absent key is the scope: a family carrying an account id would be
    // stored against that account and claim to describe it.
    const [family] = buildFeatureRequests(request(), inputs());

    expect(family && "instagramAccountId" in family).toBe(false);
  });

  it("carries the publishing account onto every observation", () => {
    // The pooled dominance rule counts posts per account, and can only do that
    // if each observation still says which account published it.
    const [family] = buildFeatureRequests(request(), inputs());

    expect(
      family?.candidates[0]?.group.map((observation) => observation.instagramAccountId),
    ).toEqual(["account-a", "account-b", "account-a"]);
  });
});
