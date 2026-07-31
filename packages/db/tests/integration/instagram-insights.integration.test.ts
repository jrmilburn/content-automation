import { loadDatabaseConfig } from "@studio-parallel/config";
import type { InstagramMetricObservation } from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import {
  listInstagramMetricSnapshots,
  recordInstagramMetricSnapshot,
} from "../../src/instagram-insights.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const now = new Date("2026-07-31T00:00:00.000Z");
const publishedAt = new Date("2026-07-30T00:00:00.000Z");

let accountId: string;
let postId: string;

function observation(
  canonical: InstagramMetricObservation["canonical"],
  availability: InstagramMetricObservation["availability"],
  value: number | null = null,
  overrides: Partial<InstagramMetricObservation> = {},
): InstagramMetricObservation {
  return {
    availability,
    canonical,
    description: null,
    period: "lifetime",
    providerName: canonical,
    providerUnit: "count",
    title: null,
    unit: "count",
    value,
    ...overrides,
  };
}

const baseObservations: readonly InstagramMetricObservation[] = [
  observation("views", "available", 1000),
  observation("reach", "available", 800),
  observation("likes", "available", 0),
  observation("plays", "not_requested"),
  observation("follows", "permission_missing"),
];

function record(
  observations: readonly InstagramMetricObservation[] = baseObservations,
  overrides: Partial<Parameters<typeof recordInstagramMetricSnapshot>[2]> = {},
) {
  return recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: now,
    instagramPostId: postId,
    observations,
    postAgeSeconds: 86_400,
    rawPayload: { distribution: { data: [] } },
    ...overrides,
  });
}

async function clearSnapshots(): Promise<void> {
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
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

describe("recordInstagramMetricSnapshot", () => {
  it("stores available values in their typed columns and the reason for every other metric", async () => {
    const result = await record();
    expect(result.created).toBe(true);

    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    expect(stored.views).toBe(1000);
    expect(stored.reach).toBe(800);
    expect(stored.ageBucket).toBe("DAY_1");
    expect(stored.postAgeSeconds).toBe(86_400);

    const availability = stored.availability as Record<string, { availability: string }>;
    expect(availability.views?.availability).toBe("available");
    expect(availability.plays?.availability).toBe("not_requested");
    expect(availability.follows?.availability).toBe("permission_missing");
  });

  it("keeps a measured zero as a zero and an absent metric as null", async () => {
    const result = await record();
    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    // A real zero and an absent measurement must stay distinguishable.
    expect(stored.likes).toBe(0);
    expect(stored.plays).toBeNull();
    expect(stored.follows).toBeNull();
  });

  it("records an unavailable metric as null rather than zero", async () => {
    const result = await record([observation("views", "unavailable")]);
    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    expect(stored.views).toBeNull();
    expect(
      (stored.availability as Record<string, { availability: string }>).views?.availability,
    ).toBe("unavailable");
  });

  it("preserves the provider name, unit and period alongside the canonical value", async () => {
    const result = await record([
      observation("saves", "available", 12, { providerName: "saved", period: "lifetime" }),
    ]);
    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    const availability = stored.availability as Record<
      string,
      { period: string; providerName: string }
    >;
    expect(availability.saves).toMatchObject({ period: "lifetime", providerName: "saved" });
    expect(stored.saves).toBe(12);
  });

  it("stores watch time in a column wide enough for it", async () => {
    const result = await record([
      observation("total_watch_time_ms", "available", 9_000_000_000, {
        providerUnit: "milliseconds",
        unit: "milliseconds",
      }),
    ]);
    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    // Nine billion milliseconds overflows a 32-bit column.
    expect(stored.totalWatchTimeMs).toBe(9_000_000_000n);
  });

  it("stores a skip rate as an exact decimal", async () => {
    const result = await record([
      observation("skip_rate", "available", 0.12345, { providerUnit: "ratio", unit: "ratio" }),
    ]);
    const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
      where: { id: result.snapshotId },
    });

    expect(stored.skipRate?.toString()).toBe("0.12345");
  });
});

describe("snapshot deduplication", () => {
  it("collapses an identical repeat in the same bucket onto one row", async () => {
    const first = await record();
    const second = await record();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
    await expect(database.instagramMetricSnapshot.count()).resolves.toBe(1);
  });

  it("records a new snapshot when a single value changes", async () => {
    await record();
    const changed = await record([
      observation("views", "available", 1001),
      observation("reach", "available", 800),
      observation("likes", "available", 0),
      observation("plays", "not_requested"),
      observation("follows", "permission_missing"),
    ]);

    // History is retained rather than overwritten, so a provider correction
    // stays visible as two observations.
    expect(changed.created).toBe(true);
    await expect(database.instagramMetricSnapshot.count()).resolves.toBe(2);
  });

  it("records a new snapshot when availability changes but values do not", async () => {
    await record([observation("views", "unavailable")]);
    const later = await record([observation("views", "available", 0)]);

    // Unavailable becoming a measured zero is a real change, not a duplicate.
    expect(later.created).toBe(true);
    await expect(database.instagramMetricSnapshot.count()).resolves.toBe(2);
  });

  it("keeps identical values in different age buckets as separate observations", async () => {
    await record(baseObservations, { postAgeSeconds: 3_600 });
    const later = await record(baseObservations, { postAgeSeconds: 604_800 });

    expect(later.created).toBe(true);
    const buckets = await database.instagramMetricSnapshot.findMany({
      select: { ageBucket: true },
    });
    expect(buckets.map((row) => row.ageBucket).sort()).toEqual(["DAY_7", "HOUR_1"]);
  });

  it("ignores non-measurement detail when deciding whether something changed", async () => {
    await record([observation("views", "available", 10, { title: "Views" })]);
    const relabelled = await record([
      observation("views", "available", 10, { title: "Plays and views" }),
    ]);

    // A renamed title is not a new measurement.
    expect(relabelled.created).toBe(false);
  });
});

describe("snapshot validation", () => {
  it("refuses an observation set with nothing in it", async () => {
    await expect(record([])).rejects.toMatchObject({ code: "SNAPSHOT_OBSERVATIONS_EMPTY" });
  });

  it("refuses a negative value before it reaches the database", async () => {
    await expect(record([observation("views", "available", -1)])).rejects.toMatchObject({
      code: "SNAPSHOT_VALUE_INVALID",
    });
  });

  it("refuses a ratio above one", async () => {
    await expect(
      record([observation("skip_rate", "available", 1.5, { unit: "ratio" })]),
    ).rejects.toMatchObject({ code: "SNAPSHOT_RATIO_INVALID" });
  });

  it("is refused by the database constraint if a negative value ever got past validation", async () => {
    const result = await record();

    await expect(
      database.$executeRaw`UPDATE instagram_metric_snapshots SET views = -5 WHERE id = ${result.snapshotId}::uuid`,
    ).rejects.toThrow();
  });

  it("is refused by the database constraint for an out-of-range skip rate", async () => {
    const result = await record();

    await expect(
      database.$executeRaw`UPDATE instagram_metric_snapshots SET skip_rate = 2 WHERE id = ${result.snapshotId}::uuid`,
    ).rejects.toThrow();
  });
});

describe("listInstagramMetricSnapshots", () => {
  it("returns snapshots newest first without the restricted raw payload", async () => {
    await record(baseObservations, { capturedAt: new Date("2026-07-30T12:00:00.000Z") });
    await record([observation("views", "available", 2000)], {
      capturedAt: new Date("2026-07-31T12:00:00.000Z"),
    });

    const snapshots = await listInstagramMetricSnapshots(database, context, {
      instagramPostId: postId,
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.capturedAt.toISOString()).toBe("2026-07-31T12:00:00.000Z");
    expect(JSON.stringify(snapshots)).not.toContain("rawPayload");
  });

  it("reads nothing for another workspace", async () => {
    await record();
    const foreign = createWorkspaceContext("019a0000-0000-7000-8000-0000000007ff");

    await expect(
      listInstagramMetricSnapshots(database, foreign, { instagramPostId: postId }),
    ).resolves.toEqual([]);
  });
});
