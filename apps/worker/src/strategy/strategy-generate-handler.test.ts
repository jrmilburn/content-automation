import { queueDefinitions, renderStrategyManifest } from "@studio-parallel/domain";
import { createFakeGemini } from "@studio-parallel/integrations";
import { describe, expect, it } from "vitest";

import { strategyGenerateQueue } from "./strategy-generate-handler.js";

/**
 * What the strategy handler is allowed to send, and what it is allowed to keep.
 *
 * The parts that need a database — publication, the current pointer, the repair
 * bound surviving a redelivery — are proven in the integration suite. What is
 * checked here is the boundary the handler owns on its own: that a text request
 * carries no video, that the manifest it renders states only what the validator
 * will hold the response to, and that no post text can reach the provider.
 */

describe("strategyGenerateQueue", () => {
  it("matches a declared queue definition", () => {
    expect(queueDefinitions).toContainEqual({
      name: strategyGenerateQueue.name,
      version: strategyGenerateQueue.version,
    });
  });
});

describe("the text-only provider request", () => {
  it("sends no file part, so no video is uploaded to reason about text", async () => {
    // Strategy interprets evidence application code already selected. Requiring
    // a file would mean uploading a video the model never looks at, and paying
    // for it.
    const gemini = createFakeGemini();
    gemini.setResponse({ text: JSON.stringify({ ok: true }) });

    const result = await gemini.adapter.generateStructuredText({ instruction: "manifest text" });

    expect(result.text).toBe(JSON.stringify({ ok: true }));
    expect(gemini.instructions()).toEqual(["manifest text"]);
    expect(gemini.fileCount()).toBe(0);
  });

  it("still refuses a file request whose file was never uploaded", async () => {
    // The text path must not weaken the video path: an analysis request naming a
    // file that does not exist is still a caller error.
    const gemini = createFakeGemini();
    gemini.setResponse({ text: "{}" });

    await expect(
      gemini.adapter.generateStructuredText({
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/missing",
        instruction: "analyse",
        mimeType: "video/mp4",
      }),
    ).rejects.toThrow();
  });
});

describe("the rendered manifest", () => {
  const identity = {
    ageWindow: "day_30",
    instagramAccountId: "account_1",
    primaryMetric: "engagement_rate_reach",
    publishedFrom: "2026-02-01T00:00:00.000Z",
    publishedTo: "2026-08-01T00:00:00.000Z",
  } as const;

  const entry = {
    allowedNumericClaims: ["12.5%"],
    allowedRoles: ["supporting"],
    category: "positive_statistic",
    classification: "moderate_association",
    dimensions: ["hook"],
    evidenceKey: "stat_pos_0",
    evidenceType: "feature_statistic",
    postIds: [],
    rank: 0,
    rankScore: 0.125,
    referenceId: "stat_1",
    requiredInLimitations: false,
    retrievalReason: "meets_moderate_thresholds",
    sampleSize: 14,
    summaryText: "content.hook.category=question on engagement_rate_reach: 12.5% vs comparison",
  } as const;

  it("renders from the frozen rows without needing the versions behind them", () => {
    // A handler reading frozen evidence back does not hold the run or the
    // version set, and asking it to would invite placeholder values in the text
    // the model is actually shown.
    const rendered = renderStrategyManifest(identity, [entry]);

    expect(rendered).toContain("evidenceId=stat_pos_0");
    expect(rendered).toContain("classification=moderate_association");
    expect(rendered).toContain("sampleSize=14");
  });

  it("states the account, metric, window and period the claims are scoped to", () => {
    // Every empirical statement has to be scoped to this account and period, so
    // the scope has to be in the text rather than assumed.
    const rendered = renderStrategyManifest(identity, [entry]);

    expect(rendered).toContain("account_1");
    expect(rendered).toContain("engagement_rate_reach");
    expect(rendered).toContain("day_30");
    expect(rendered).toContain("2026-02-01");
  });

  it("bounds the numbers an explanation may contain to the ones it was given", () => {
    const rendered = renderStrategyManifest(identity, [entry]);

    expect(rendered).toContain("allowedNumbersInExplanations=12.5%");
    expect(rendered).toContain("Write no other digits in an explanation.");
  });

  it("names the manifest as untrusted data rather than instructions", () => {
    // The summaries derive from model output about an account's own posts. The
    // prompt has to frame them as data, or a crafted summary reads as direction.
    expect(renderStrategyManifest(identity, [entry])).toContain("untrusted data");
  });
});
