import {
  hashInstagramInsightObservations,
  instagramSnapshotBucketFor,
  type InstagramCanonicalMetric,
  type InstagramMetricObservation,
} from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Immutable metric snapshot writes.
 *
 * A snapshot is never updated. Re-observing identical values collapses onto the
 * existing row through the `(post, bucket, api version, payload hash)` unique
 * index, while a single changed value hashes differently and records a new
 * observation — so a provider correction is visible as history rather than
 * silently overwriting what was measured before.
 *
 * A value column is written only when its observation is `available`. Every
 * other state leaves the column null and is explained by the `availability`
 * map, because Meta documents an unavailable insight as empty data and a
 * substituted zero would be indistinguishable from a real measurement.
 */

type SnapshotDatabase = PrismaClient | Prisma.TransactionClient;

const bucketEnum = {
  day_1: "DAY_1",
  day_3: "DAY_3",
  day_7: "DAY_7",
  day_30: "DAY_30",
  hour_1: "HOUR_1",
  import: "IMPORT",
  mature: "MATURE",
} as const;

/** Canonical metric to the column that stores its value. */
const metricColumns = {
  average_watch_time_ms: "averageWatchTimeMs",
  comments: "comments",
  follows: "follows",
  likes: "likes",
  plays: "plays",
  profile_activity: "profileActivity",
  profile_visits: "profileVisits",
  reach: "reach",
  saves: "saves",
  shares: "shares",
  skip_rate: "skipRate",
  total_interactions: "totalInteractions",
  total_watch_time_ms: "totalWatchTimeMs",
  views: "views",
} as const satisfies Record<InstagramCanonicalMetric, string>;

export type InstagramSnapshotInput = Readonly<{
  apiVersion: string;
  capturedAt: Date;
  followerCount?: number | null;
  instagramPostId: string;
  observations: readonly InstagramMetricObservation[];
  postAgeSeconds: number;
  rawPayload: Prisma.InputJsonValue;
  syncRunId?: string | null;
}>;

export type InstagramSnapshotCommit = Readonly<{
  /** False when an identical observation already existed in this bucket. */
  created: boolean;
  payloadHash: string;
  snapshotId: string;
}>;

function snapshotError(code: string, statusCode = 400): OperationalError {
  return new OperationalError({ code, errorClass: "validation", statusCode });
}

/**
 * Splits observations into the typed columns and the availability map.
 *
 * Watch time is the one count wide enough to need a bigint; the rest are
 * integers. A ratio keeps its precision as a decimal rather than a float so a
 * stored skip rate compares exactly.
 */
function toColumns(observations: readonly InstagramMetricObservation[]) {
  const values: Record<string, bigint | number | string | null> = {};
  const availability: Record<string, unknown> = {};

  for (const entry of observations) {
    const column = metricColumns[entry.canonical];
    availability[entry.canonical] = {
      availability: entry.availability,
      description: entry.description,
      period: entry.period,
      providerName: entry.providerName,
      providerUnit: entry.providerUnit,
      unit: entry.unit,
    };

    if (entry.availability !== "available" || entry.value === null) continue;
    if (!Number.isFinite(entry.value) || entry.value < 0) {
      throw snapshotError("SNAPSHOT_VALUE_INVALID");
    }

    if (entry.canonical === "total_watch_time_ms") {
      values[column] = BigInt(Math.round(entry.value));
    } else if (entry.canonical === "skip_rate") {
      if (entry.value > 1) throw snapshotError("SNAPSHOT_RATIO_INVALID");
      // A string keeps the decimal exact through the driver.
      values[column] = entry.value.toFixed(5);
    } else {
      values[column] = Math.round(entry.value);
    }
  }

  return { availability, values };
}

/**
 * Records one observation of a post's metrics.
 *
 * `createMany` with `skipDuplicates` emits `ON CONFLICT DO NOTHING`, so two
 * workers observing the same values concurrently both succeed and one row
 * exists, rather than one taking a unique violation that would abort its
 * transaction.
 */
export async function recordInstagramMetricSnapshot(
  database: SnapshotDatabase,
  context: WorkspaceContext,
  input: InstagramSnapshotInput,
): Promise<InstagramSnapshotCommit> {
  if (input.observations.length === 0) throw snapshotError("SNAPSHOT_OBSERVATIONS_EMPTY");
  if (!Number.isFinite(input.postAgeSeconds)) throw snapshotError("SNAPSHOT_POST_AGE_INVALID");

  const postAgeSeconds = Math.max(0, Math.round(input.postAgeSeconds));
  const ageBucket = bucketEnum[instagramSnapshotBucketFor(input.postAgeSeconds)];
  const payloadHash = hashInstagramInsightObservations(input.observations);
  const { availability, values } = toColumns(input.observations);
  const snapshotId = createId();

  await database.instagramMetricSnapshot.createMany({
    data: [
      {
        ageBucket,
        apiVersion: input.apiVersion,
        availability: availability as Prisma.InputJsonValue,
        capturedAt: input.capturedAt,
        followerCount: input.followerCount ?? null,
        id: snapshotId,
        instagramPostId: input.instagramPostId,
        postAgeSeconds,
        rawPayload: input.rawPayload,
        rawPayloadHash: payloadHash,
        syncRunId: input.syncRunId ?? null,
        workspaceId: context.workspaceId,
        ...values,
      },
    ],
    skipDuplicates: true,
  });

  const stored = await database.instagramMetricSnapshot.findFirstOrThrow({
    select: { id: true },
    where: {
      ageBucket,
      apiVersion: input.apiVersion,
      instagramPostId: input.instagramPostId,
      rawPayloadHash: payloadHash,
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze({
    created: stored.id === snapshotId,
    payloadHash,
    snapshotId: stored.id,
  });
}

export type InstagramSnapshotSummary = Readonly<{
  ageBucket: string;
  apiVersion: string;
  availability: unknown;
  capturedAt: Date;
  id: string;
  instagramPostId: string;
  postAgeSeconds: number;
}>;

/**
 * Reads recent snapshots for a post, newest first.
 *
 * The raw payload is deliberately absent: it is restricted provenance, and the
 * safe projection is the only supported read path, exactly as for posts.
 */
export async function listInstagramMetricSnapshots(
  database: SnapshotDatabase,
  context: WorkspaceContext,
  input: Readonly<{ instagramPostId: string; take?: number }>,
): Promise<readonly InstagramSnapshotSummary[]> {
  const rows = await database.instagramMetricSnapshot.findMany({
    orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
    select: {
      ageBucket: true,
      apiVersion: true,
      availability: true,
      capturedAt: true,
      id: true,
      instagramPostId: true,
      postAgeSeconds: true,
    },
    take: Math.min(Math.max(input.take ?? 20, 1), 100),
    where: { instagramPostId: input.instagramPostId, workspaceId: context.workspaceId },
  });

  return Object.freeze(rows.map((row) => Object.freeze(row)));
}
