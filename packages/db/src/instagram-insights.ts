import {
  hashInstagramInsightObservations,
  instagramSnapshotBucketFor,
  type InstagramCanonicalMetric,
  type InstagramMetricObservation,
} from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import { markAnalyticsDirty } from "./analytics-runs.js";
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

  const created = stored.id === snapshotId;

  if (created) {
    // A genuinely new observation changes the values every comparison for this
    // account is calculated over. A collapsed duplicate does not, so it must not
    // dirty the account — a capture that observed nothing new would otherwise
    // keep restarting the debounce window and the recalculation would never run.
    const post = await database.instagramPost.findFirst({
      select: { instagramAccountId: true },
      where: { id: input.instagramPostId, workspaceId: context.workspaceId },
    });

    if (post) {
      await markAnalyticsDirty(database, context, {
        instagramAccountId: post.instagramAccountId,
        now: input.capturedAt,
      });
    }
  }

  return Object.freeze({
    created,
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

/** Every stored value column, for a read that will recompute derived metrics. */
export const instagramSnapshotValueSelect = Object.freeze({
  availability: true,
  averageWatchTimeMs: true,
  comments: true,
  follows: true,
  likes: true,
  plays: true,
  profileActivity: true,
  profileVisits: true,
  reach: true,
  saves: true,
  shares: true,
  skipRate: true,
  totalInteractions: true,
  totalWatchTimeMs: true,
  views: true,
} as const);

export type InstagramSnapshotValueRow = Readonly<{
  availability: unknown;
  averageWatchTimeMs: number | null;
  comments: number | null;
  follows: number | null;
  likes: number | null;
  plays: number | null;
  profileActivity: number | null;
  profileVisits: number | null;
  reach: number | null;
  saves: number | null;
  shares: number | null;
  skipRate: unknown;
  totalInteractions: number | null;
  totalWatchTimeMs: bigint | null;
  views: number | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readColumnValue(canonical: InstagramCanonicalMetric, row: InstagramSnapshotValueRow) {
  const raw = (row as unknown as Record<string, unknown>)[metricColumns[canonical]];

  if (raw === null || raw === undefined) return null;
  // Watch time is stored wide and a ratio is stored exact; both come back as
  // something other than a number and must be narrowed here rather than by a
  // caller that has no reason to know how the column was chosen.
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  const parsed = Number(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Rebuilds the observations a snapshot row was written from.
 *
 * This is the exact inverse of the column split above and lives beside it so the
 * two cannot drift: a metric added to `metricColumns` is readable the moment it
 * is writable.
 *
 * A column is trusted only when the availability map says the observation was
 * available. A stored value with any other availability would be a write-path
 * defect, and honouring it here would launder that defect into a metric.
 *
 * `title` is not recovered because it was never stored — it is provider display
 * text with no bearing on a calculation, and the contract keeps only the fields
 * that change a value's meaning.
 */
export function readInstagramSnapshotObservations(
  row: InstagramSnapshotValueRow,
): readonly InstagramMetricObservation[] {
  const availability = isRecord(row.availability) ? row.availability : {};
  const observations: InstagramMetricObservation[] = [];

  for (const key of Object.keys(metricColumns)) {
    const canonical = key as InstagramCanonicalMetric;
    const entry = availability[canonical];
    if (!isRecord(entry)) continue;

    const state = entry["availability"];
    const observation: InstagramMetricObservation = {
      availability: (typeof state === "string"
        ? state
        : "unavailable") as InstagramMetricObservation["availability"],
      canonical,
      description: typeof entry["description"] === "string" ? entry["description"] : null,
      period: typeof entry["period"] === "string" ? entry["period"] : null,
      providerName: typeof entry["providerName"] === "string" ? entry["providerName"] : null,
      providerUnit: (entry["providerUnit"] ?? null) as InstagramMetricObservation["providerUnit"],
      title: null,
      unit: (entry["unit"] ?? null) as InstagramMetricObservation["unit"],
      value: state === "available" ? readColumnValue(canonical, row) : null,
    };

    observations.push(Object.freeze(observation));
  }

  return Object.freeze(observations);
}
