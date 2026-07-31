import { instagramSnapshotBucketFor, type InstagramSnapshotBucket } from "./instagram-insights.js";
import type { InstagramSyncTrigger } from "./instagram-media.js";

/**
 * Pure scheduling contract: what is due, and the keys that make repeated
 * scheduling idempotent.
 *
 * A key is the whole deduplication mechanism. `enqueueBackgroundJob` collapses
 * on `(workspace, queue, handler version, idempotency key)`, so bucketing the
 * key by time is what turns a sweep that runs every few minutes into at most
 * one job per unit of work per window — without a `due_at` column that two
 * workers would race to claim.
 *
 * Keys deliberately avoid `.`: the job table accepts it but the sync-run key
 * pattern does not, so a dotted key would enqueue and then fail its handler
 * with a non-retryable validation error.
 */

/** Accepted by both the background job and the sync run key patterns. */
const safeSchedulingKeyPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/u;

export function isSafeSchedulingKey(value: string): boolean {
  return safeSchedulingKeyPattern.test(value);
}

/** How often a connected account is swept for new media. */
export const instagramAccountSyncIntervalHours = 24;

/**
 * How far back a repeat import reaches.
 *
 * Wide enough to re-see anything a previous run could have missed or that has
 * since been edited, and short enough that a daily sweep does not re-page
 * months of unchanged media. A first import still uses the full bootstrap
 * horizon.
 */
export const instagramIncrementalOverlapDays = 14;

/**
 * How long after a bucket opens a snapshot may still be taken.
 *
 * The buckets themselves already carry the tolerance — `day_1` accepts up to
 * 36 hours — so a scheduler only has to ask which bucket a post is in now and
 * whether that bucket has been observed. It never needs to promise an exact
 * timestamp, and it must never record a late observation against an earlier
 * target.
 */
export type InstagramSnapshotDue = Readonly<{
  ageBucket: InstagramSnapshotBucket;
  postAgeSeconds: number;
}>;

/**
 * The bucket a post is due for now, or null when nothing is owed.
 *
 * `mature` is deliberately excluded: it is unbounded, so treating it as due
 * would re-observe every old post forever. Analytics compares within buckets,
 * and a bucket that never closes cannot be compared against anything.
 */
export function instagramSnapshotDueFor(
  input: Readonly<{ capturedBuckets: readonly string[]; postAgeSeconds: number }>,
): InstagramSnapshotDue | null {
  // Normalised before bucketing, not after. Bucketing the raw value and then
  // reporting a floored one can put the recorded age outside the recorded
  // bucket, so the observation would contradict itself and a later
  // recomputation would disagree with what was stored.
  const postAgeSeconds = Number.isNaN(input.postAgeSeconds)
    ? 0
    : Math.max(0, Math.floor(input.postAgeSeconds));

  const ageBucket = instagramSnapshotBucketFor(postAgeSeconds);
  if (ageBucket === "mature") return null;
  if (input.capturedBuckets.includes(ageBucket)) return null;

  return Object.freeze({ ageBucket, postAgeSeconds });
}

function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function minuteBucket(at: Date): string {
  // Minute resolution, with the separators the key pattern forbids removed.
  return at.toISOString().slice(0, 16).replace(/[-:T]/gu, "");
}

/**
 * Key for a scheduled account sync.
 *
 * Bucketed by UTC day, so a sweep running every few minutes across several
 * workers produces one scheduled import per account per day rather than a queue
 * of duplicates.
 */
export function instagramScheduledSyncKey(accountId: string, at: Date): string {
  return `instagram-sync-scheduled-${accountId}-${dayBucket(at)}`;
}

/**
 * Key for an operator-requested sync.
 *
 * Bucketed by minute rather than by day: a manual request is a deliberate act
 * and an operator who waits should be able to ask again. Two clicks in the same
 * minute collapse, and the one-RUNNING-run-per-trigger index stops a second
 * request overlapping the first regardless.
 */
export function instagramManualSyncKey(accountId: string, at: Date): string {
  return `instagram-sync-manual-${accountId}-${minuteBucket(at)}`;
}

/**
 * Key for one post's snapshot in one age bucket.
 *
 * Carries no timestamp: a bucket is observed at most once per post, so the
 * bucket itself is the window. A late capture therefore still lands in the
 * bucket its age puts it in, which is what stops a missed target being
 * backdated to the one it missed.
 */
export function instagramSnapshotKey(postId: string, ageBucket: InstagramSnapshotBucket): string {
  return `instagram-snapshot-${postId}-${ageBucket}`;
}

/** The trigger a scheduling key encodes, or null when it encodes none. */
export function instagramSyncTriggerFromKey(key: string): InstagramSyncTrigger | null {
  if (key.startsWith("instagram-sync-manual-")) return "MANUAL";
  if (key.startsWith("instagram-sync-scheduled-")) return "SCHEDULED";
  // The connection flow's bootstrap key predates this scheme and is the only
  // remaining producer of a first import.
  if (key.startsWith("instagram-bootstrap-sync-")) return "BOOTSTRAP";
  return null;
}

/**
 * Priority for a queued sync.
 *
 * An operator waiting on a manual request outranks a sweep that will come round
 * again on its own.
 */
export function instagramSyncPriority(trigger: InstagramSyncTrigger): number {
  return trigger === "MANUAL" ? 10 : 0;
}
