import { loadDatabaseConfig } from "@studio-parallel/config";
import {
  calculateDerivedMetric,
  createMetricInputs,
  resolveMetricDuration,
  type InstagramMetricObservation,
  type MetricInputKey,
} from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import { recordInstagramMetricSnapshot } from "../../src/instagram-insights.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * Proves the boundary between a persisted snapshot and the metric engine.
 *
 * The unit tests exercise the formulas against observations held in memory. What
 * only a database can show is that a metric absent from the provider is stored as
 * a NULL column and comes back as unavailable rather than as a zero, and that the
 * integer, bigint and decimal columns survive the driver without losing the exact
 * values the formulas divide.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const now = new Date("2026-08-02T00:00:00.000Z");
const publishedAt = new Date("2026-08-01T00:00:00.000Z");

let accountId: string;
let postId: string;

function observation(
  canonical: InstagramMetricObservation["canonical"],
  availability: InstagramMetricObservation["availability"],
  value: number | null = null,
  unit: InstagramMetricObservation["unit"] = "count",
): InstagramMetricObservation {
  return {
    availability,
    canonical,
    description: null,
    period: "lifetime",
    providerName: canonical,
    providerUnit: unit,
    title: null,
    unit,
    value,
  };
}

/** The stored columns each engine input reads, in the engine's vocabulary. */
const columnFor = {
  average_watch_time_ms: "averageWatchTimeMs",
  comments: "comments",
  follows: "follows",
  likes: "likes",
  profile_visits: "profileVisits",
  reach: "reach",
  saves: "saves",
  shares: "shares",
} as const satisfies Record<MetricInputKey, string>;

type StoredAvailability = Record<
  string,
  { availability: InstagramMetricObservation["availability"]; unit: string | null } | undefined
>;

/**
 * Rebuilds observations from the persisted row, taking the unit from the stored
 * availability map rather than restating it, so a unit lost in storage surfaces
 * as an incompatible-unit failure instead of passing silently.
 */
function observationsFromStoredSnapshot(
  row: Record<string, unknown> & { availability: unknown },
): InstagramMetricObservation[] {
  const stored = row.availability as StoredAvailability;

  return (Object.keys(columnFor) as MetricInputKey[]).map((canonical) => {
    const raw = row[columnFor[canonical]];
    const value = typeof raw === "number" ? raw : raw === null ? null : Number(raw);
    const entry = stored[canonical];
    return observation(
      canonical,
      value === null ? (entry?.availability ?? "unavailable") : "available",
      value,
      (entry?.unit as InstagramMetricObservation["unit"]) ?? "count",
    );
  });
}

async function clearSnapshots(): Promise<void> {
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

async function storeAndRead(observations: readonly InstagramMetricObservation[]) {
  const result = await recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: now,
    instagramPostId: postId,
    observations,
    postAgeSeconds: 86_400,
    rawPayload: { engagement: { data: [] } },
  });

  const row = await database.instagramMetricSnapshot.findFirstOrThrow({
    where: { id: result.snapshotId },
  });

  return createMetricInputs({
    duration: resolveMetricDuration({ validatedSourceSeconds: 20 }),
    observations: observationsFromStoredSnapshot(
      row as unknown as Record<string, unknown> & { availability: unknown },
    ),
    snapshotId: result.snapshotId,
  });
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clearSnapshots();

  accountId = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes: ["instagram_business_basic"],
      id: accountId,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });

  postId = createId();
  await database.instagramPost.create({
    data: {
      firstImportedAt: now,
      id: postId,
      instagramAccountId: accountId,
      lastImportedAt: now,
      mediaKind: "REEL",
      mediaProductType: "REELS",
      mediaType: "VIDEO",
      providerMediaId: `media-${postId.slice(-12)}`,
      publishedAt,
      rawApiVersion: "v25.0",
      rawPayload: {},
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: now,
      workspaceId: developmentWorkspace.id,
    },
  });
});

afterAll(async () => {
  await clearSnapshots();
  await database.$disconnect();
});

describe("derived metrics over a persisted snapshot", () => {
  const complete: readonly InstagramMetricObservation[] = [
    observation("reach", "available", 4_000),
    observation("likes", "available", 250),
    observation("comments", "available", 30),
    observation("shares", "available", 60),
    observation("saves", "available", 90),
    observation("follows", "available", 12),
    observation("profile_visits", "available", 48),
    observation("average_watch_time_ms", "available", 12_000, "milliseconds"),
    // Stored in the wide and decimal columns; no formula may read either.
    observation("total_watch_time_ms", "available", 9_007_199_254_740_991, "milliseconds"),
    observation("skip_rate", "available", 0.42_531, "ratio"),
  ];

  it("derives the same values the in-memory contract produces", async () => {
    const inputs = await storeAndRead(complete);

    // Hand-computed from the stored numbers, per the analytics contract.
    expect(calculateDerivedMetric("engagement_count", inputs).value).toBe(430);
    expect(calculateDerivedMetric("engagement_rate_reach", inputs).value).toBeCloseTo(0.1075, 10);
    expect(calculateDerivedMetric("like_rate_reach", inputs).value).toBeCloseTo(0.0625, 10);
    expect(calculateDerivedMetric("follow_conversion_rate", inputs).value).toBeCloseTo(0.25, 10);
    expect(calculateDerivedMetric("average_watch_percentage", inputs).value).toBeCloseTo(0.6, 10);
    expect(calculateDerivedMetric("completion_proxy", inputs).value).toBeCloseTo(0.6, 10);
  });

  it("reads a NULL column as unavailable rather than as zero", async () => {
    // The provider refused reach; the column is NULL. A zero here would report a
    // post that reached nobody, and every reach rate would divide by it.
    const result = await storeAndRead([
      ...complete.filter((entry) => entry.canonical !== "reach"),
      observation("reach", "permission_missing"),
    ]);

    expect(result.values.reach.available).toBe(false);

    const rate = calculateDerivedMetric("like_rate_reach", result);
    expect(rate.availability).toBe("unavailable");
    expect(rate.value).toBeNull();
    expect(rate.reason).toBe("denominator_unavailable");
  });

  it("keeps an engagement component absent rather than summing a partial engagement", async () => {
    const result = await storeAndRead([
      ...complete.filter((entry) => entry.canonical !== "saves"),
      observation("saves", "unavailable"),
    ]);

    const engagement = calculateDerivedMetric("engagement_count", result);
    expect(engagement.availability).toBe("unavailable");
    expect(engagement.value).toBeNull();
    expect(engagement.missing).toEqual(["saves"]);
  });

  it("preserves exact integer counts through the driver", async () => {
    const inputs = await storeAndRead(complete);
    const likes = inputs.values.likes;

    expect(likes.available).toBe(true);
    if (likes.available) {
      expect(likes.value).toBe(250);
      expect(Number.isSafeInteger(likes.value)).toBe(true);
    }
  });

  it("stores a real measured zero and still derives a value from it", async () => {
    const inputs = await storeAndRead([
      ...complete.filter((entry) => entry.canonical !== "likes"),
      observation("likes", "available", 0),
    ]);

    const rate = calculateDerivedMetric("like_rate_reach", inputs);
    expect(rate.availability).toBe("available");
    expect(rate.value).toBe(0);
  });
});
