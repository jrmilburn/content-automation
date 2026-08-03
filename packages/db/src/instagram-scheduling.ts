import {
  instagramApiVersion,
  instagramInsightMediaKinds,
  instagramSnapshotBucketFor,
  instagramSnapshotDueFor,
  type InstagramSnapshotBucket,
} from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Due-work sweeps for the sync scheduler.
 *
 * These are system sweeps like the job reconciler, so they are not
 * workspace-scoped; each returned row carries its workspace so the enqueue that
 * follows is. They select identifiers only — never credential material — and
 * are bounded, so one workspace with a large backlog cannot starve the rest.
 *
 * No schedule table backs any of this. Due state is derived from watermarks the
 * product already maintains, and the idempotency key supplies the deduplication
 * a `due_at` column would otherwise need two workers to race for.
 */

type SchedulingDatabase = PrismaClient;

const maximumBatch = 200;

function boundedTake(limit: number): number {
  return Math.min(Math.max(limit, 1), maximumBatch);
}

export type InstagramAccountDueForSync = Readonly<{
  accountId: string;
  lastSuccessfulSyncAt: Date | null;
  workspaceId: string;
}>;

/**
 * Connected accounts whose last successful import is older than the interval.
 *
 * A never-synced account is included: a null watermark means the import has not
 * happened, not that it is not due. Only `ACTIVE` connections are returned, so
 * a disconnected or reauthorisation-required account stops being scheduled
 * without any separate suppression list.
 */
export async function listInstagramAccountsDueForSync(
  database: SchedulingDatabase,
  input: Readonly<{ dueBefore: Date; limit: number }>,
): Promise<readonly InstagramAccountDueForSync[]> {
  const accounts = await database.instagramAccount.findMany({
    orderBy: [{ lastSuccessfulSyncAt: { nulls: "first", sort: "asc" } }, { id: "asc" }],
    select: { id: true, lastSuccessfulSyncAt: true, workspaceId: true },
    take: boundedTake(input.limit),
    where: {
      connectionStatus: "ACTIVE",
      OR: [{ lastSuccessfulSyncAt: null }, { lastSuccessfulSyncAt: { lte: input.dueBefore } }],
    },
  });

  return Object.freeze(
    accounts.map((account) =>
      Object.freeze({
        accountId: account.id,
        lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
        workspaceId: account.workspaceId,
      }),
    ),
  );
}

export type InstagramPostDueForSnapshot = Readonly<{
  ageBucket: InstagramSnapshotBucket;
  postAgeSeconds: number;
  postId: string;
  workspaceId: string;
}>;

/**
 * Posts whose current age bucket has not been observed yet.
 *
 * Candidates are read newest first and filtered in code rather than in SQL: the
 * bucket boundaries live in the domain contract, and duplicating them as SQL
 * intervals would let the two drift apart silently.
 *
 * Two reads rather than one, because the two populations are bounded by
 * different things. A post inside the closing buckets is bounded by time — it
 * ages out of contention on its own. A post past them can only ever be owed
 * `mature`, and nothing ages it out, so it is bounded instead by whether that
 * one observation exists. Folding both into a single `OR` behind a single
 * `take` would let an account with enough recent posts fill the batch on every
 * tick and starve its own back catalogue indefinitely, since settled posts sort
 * last.
 *
 * The settled read converges: a post leaves it the moment its `mature` snapshot
 * exists. It is narrowed to the media kinds the capability map can actually
 * request, because the handler writes no row for a kind it cannot ask about —
 * so without that filter a feed post would remain owed forever and hold a slot
 * on every sweep. The closing read needs no such filter; time removes those.
 */
export async function listInstagramPostsDueForSnapshot(
  database: SchedulingDatabase,
  input: Readonly<{ limit: number; now: Date }>,
): Promise<readonly InstagramPostDueForSnapshot[]> {
  const oldestDueAgeSeconds = 3_456_000;
  const publishedAfter = new Date(input.now.getTime() - oldestDueAgeSeconds * 1000);
  const take = boundedTake(input.limit);

  const [closing, settled] = await Promise.all([
    database.instagramPost.findMany({
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        publishedAt: true,
        snapshots: { select: { ageBucket: true } },
        workspaceId: true,
      },
      // Read more candidates than the batch, because most will already have
      // their current bucket observed and contribute nothing.
      take: take * 5,
      where: {
        account: { connectionStatus: "ACTIVE" },
        publishedAt: { gte: publishedAfter },
      },
    }),
    database.instagramPost.findMany({
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        publishedAt: true,
        snapshots: { select: { ageBucket: true } },
        workspaceId: true,
      },
      // No multiplier here: the absence of the snapshot is the whole condition,
      // so every row read is genuinely owed.
      take,
      where: {
        account: { connectionStatus: "ACTIVE" },
        mediaKind: { in: [...instagramInsightMediaKinds(instagramApiVersion)] },
        publishedAt: { lt: publishedAfter },
        snapshots: { none: { ageBucket: "MATURE" } },
      },
    }),
  ]);

  const due: InstagramPostDueForSnapshot[] = [];
  // Closing buckets first. Their window shuts, and a settled post's does not.
  for (const post of [...closing, ...settled]) {
    if (due.length >= take) break;

    const postAgeSeconds = Math.floor((input.now.getTime() - post.publishedAt.getTime()) / 1000);
    const owed = instagramSnapshotDueFor({
      // The column is an upper-case enum and the domain contract is lower-case;
      // comparing them unconverted would match nothing and leave every post
      // looking permanently due.
      capturedBuckets: post.snapshots.map((snapshot) => String(snapshot.ageBucket).toLowerCase()),
      postAgeSeconds,
    });
    if (!owed) continue;

    due.push(
      Object.freeze({
        ageBucket: owed.ageBucket,
        postAgeSeconds: owed.postAgeSeconds,
        postId: post.id,
        workspaceId: post.workspaceId,
      }),
    );
  }

  return Object.freeze(due);
}

/**
 * Whether a sync of this purpose is already running for the account.
 *
 * The partial unique index already refuses a second RUNNING run per trigger, so
 * this is not the correctness boundary — it exists so an operator is told their
 * request is already in flight instead of watching a job fail on a conflict.
 */
export async function instagramSyncRunActive(
  database: SchedulingDatabase,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; trigger: string }>,
): Promise<boolean> {
  const running = await database.syncRun.findFirst({
    select: { id: true },
    where: {
      instagramAccountId: input.instagramAccountId,
      state: "RUNNING",
      trigger: input.trigger as never,
      workspaceId: context.workspaceId,
    },
  });

  return running !== null;
}

/**
 * The buckets already observed for a post, for reporting what was missed.
 *
 * A missed cadence is not stored anywhere: it is the absence of a `(post,
 * bucket)` row, which is derivable at read time and cannot drift out of step
 * with the snapshots themselves the way a duplicated status column would.
 */
export async function listInstagramSnapshotCoverage(
  database: SchedulingDatabase,
  context: WorkspaceContext,
  input: Readonly<{ instagramPostId: string; now: Date }>,
): Promise<
  Readonly<{
    capturedBuckets: readonly string[];
    currentBucket: InstagramSnapshotBucket;
    missedBuckets: readonly InstagramSnapshotBucket[];
  }>
> {
  const post = await database.instagramPost.findFirst({
    select: { publishedAt: true, snapshots: { select: { ageBucket: true } } },
    where: { id: input.instagramPostId, workspaceId: context.workspaceId },
  });

  if (!post) {
    return Object.freeze({
      capturedBuckets: Object.freeze([]),
      currentBucket: "import" as const,
      missedBuckets: Object.freeze([]),
    });
  }

  const postAgeSeconds = Math.floor((input.now.getTime() - post.publishedAt.getTime()) / 1000);
  const currentBucket = instagramSnapshotBucketFor(postAgeSeconds);
  const captured = new Set(
    post.snapshots.map((snapshot) => String(snapshot.ageBucket).toLowerCase()),
  );

  // Every bucket the post has already aged past, that was never observed. The
  // current bucket is excluded: it is still open, so it is owed rather than
  // missed.
  const ordered: readonly InstagramSnapshotBucket[] = [
    "import",
    "hour_1",
    "day_1",
    "day_3",
    "day_7",
    "day_30",
    "mature",
  ];
  const currentIndex = ordered.indexOf(currentBucket);
  const missed = ordered
    .slice(0, currentIndex < 0 ? 0 : currentIndex)
    .filter((bucket) => !captured.has(bucket));

  return Object.freeze({
    capturedBuckets: Object.freeze([...captured]),
    currentBucket,
    missedBuckets: Object.freeze(missed),
  });
}
