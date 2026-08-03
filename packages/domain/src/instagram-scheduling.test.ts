import { describe, expect, it } from "vitest";

import {
  instagramManualSyncKey,
  instagramScheduledSyncKey,
  instagramSnapshotDueFor,
  instagramSnapshotKey,
  instagramSyncPriority,
  instagramSyncTriggerFromKey,
  isSafeSchedulingKey,
} from "./instagram-scheduling.js";

const accountId = "019a0000-0000-7000-8000-000000000301";
const postId = "019a0000-0000-7000-8000-000000000401";
const at = new Date("2026-07-31T02:34:56.000Z");

describe("scheduling keys", () => {
  it.each([
    ["scheduled sync", instagramScheduledSyncKey(accountId, at)],
    ["manual sync", instagramManualSyncKey(accountId, at)],
    ["snapshot", instagramSnapshotKey(postId, "day_1")],
  ])("produces a %s key both key patterns accept", (_label, key) => {
    // The job table accepts `.` but the sync-run pattern does not, so a dotted
    // key would enqueue and then fail its handler with a non-retryable error.
    expect(isSafeSchedulingKey(key)).toBe(true);
    expect(key).not.toContain(".");
    expect(key.length).toBeLessThanOrEqual(255);
  });

  it("buckets a scheduled sync by UTC day so repeated sweeps collapse", () => {
    const morning = instagramScheduledSyncKey(accountId, new Date("2026-07-31T00:05:00.000Z"));
    const evening = instagramScheduledSyncKey(accountId, new Date("2026-07-31T23:55:00.000Z"));
    const tomorrow = instagramScheduledSyncKey(accountId, new Date("2026-08-01T00:05:00.000Z"));

    expect(morning).toBe(evening);
    expect(tomorrow).not.toBe(morning);
  });

  it("buckets a manual sync by minute so an operator can ask again", () => {
    const first = instagramManualSyncKey(accountId, new Date("2026-07-31T02:34:00.000Z"));
    const sameMinute = instagramManualSyncKey(accountId, new Date("2026-07-31T02:34:59.000Z"));
    const nextMinute = instagramManualSyncKey(accountId, new Date("2026-07-31T02:35:00.000Z"));

    expect(sameMinute).toBe(first);
    expect(nextMinute).not.toBe(first);
  });

  it("keys a snapshot by bucket with no timestamp", () => {
    // A bucket is observed at most once per post, so the bucket is the window.
    // A timestamp would let a late capture create a second observation of a
    // target that was already met.
    expect(instagramSnapshotKey(postId, "day_1")).toBe(instagramSnapshotKey(postId, "day_1"));
    expect(instagramSnapshotKey(postId, "day_3")).not.toBe(instagramSnapshotKey(postId, "day_1"));
  });

  it("separates accounts and posts", () => {
    const other = "019a0000-0000-7000-8000-000000000302";
    expect(instagramScheduledSyncKey(other, at)).not.toBe(instagramScheduledSyncKey(accountId, at));
  });
});

describe("instagramSyncTriggerFromKey", () => {
  it.each([
    [instagramManualSyncKey(accountId, at), "MANUAL"],
    [instagramScheduledSyncKey(accountId, at), "SCHEDULED"],
    [`instagram-bootstrap-sync-${accountId}`, "BOOTSTRAP"],
  ] as const)("reads the trigger the key encodes", (key, expected) => {
    expect(instagramSyncTriggerFromKey(key)).toBe(expected);
  });

  it.each(["something-else", "", "instagram-sync-", "instagram-snapshot-abc-day_1"])(
    "returns null for the unrecognised key %p rather than guessing",
    (key) => {
      expect(instagramSyncTriggerFromKey(key)).toBeNull();
    },
  );
});

describe("instagramSyncPriority", () => {
  it("ranks an operator request above a sweep", () => {
    // A sweep comes round again on its own; a waiting operator does not.
    expect(instagramSyncPriority("MANUAL")).toBeGreaterThan(instagramSyncPriority("SCHEDULED"));
  });

  it.each(["SCHEDULED", "BOOTSTRAP", "RECONCILE"] as const)(
    "leaves %s at the default priority",
    (trigger) => {
      expect(instagramSyncPriority(trigger)).toBe(0);
    },
  );
});

describe("instagramSnapshotDueFor", () => {
  it("owes the current bucket when it has not been observed", () => {
    expect(instagramSnapshotDueFor({ capturedBuckets: [], postAgeSeconds: 86_400 })).toEqual({
      ageBucket: "day_1",
      postAgeSeconds: 86_400,
    });
  });

  it("owes nothing once the current bucket has been observed", () => {
    expect(
      instagramSnapshotDueFor({ capturedBuckets: ["day_1"], postAgeSeconds: 86_400 }),
    ).toBeNull();
  });

  it("owes the new bucket once a post ages into it", () => {
    // An earlier bucket having been captured does not satisfy a later one.
    expect(
      instagramSnapshotDueFor({ capturedBuckets: ["import", "hour_1"], postAgeSeconds: 86_400 }),
    ).toMatchObject({ ageBucket: "day_1" });
  });

  it("owes a mature post its one observation", () => {
    // A post already past the closing buckets when its account connected has no
    // other window it can ever appear in. Refusing this one made an established
    // account's whole history permanently unmeasurable.
    expect(
      instagramSnapshotDueFor({ capturedBuckets: [], postAgeSeconds: 40_000_000 }),
    ).toMatchObject({ ageBucket: "mature", postAgeSeconds: 40_000_000 });
  });

  it("owes a mature post nothing once observed, however much older it gets", () => {
    // What bounds an unbounded bucket is that it has been captured, not that it
    // was refused. The key carries no timestamp, so one observation is all there
    // can ever be.
    expect(
      instagramSnapshotDueFor({ capturedBuckets: ["mature"], postAgeSeconds: 40_000_000 }),
    ).toBeNull();
    expect(
      instagramSnapshotDueFor({ capturedBuckets: ["mature"], postAgeSeconds: 400_000_000 }),
    ).toBeNull();
  });

  it("owes a mature observation even when earlier buckets were captured", () => {
    // The earlier windows closed while the post was young; having caught some of
    // them does not settle the one that is open now.
    expect(
      instagramSnapshotDueFor({
        capturedBuckets: ["import", "hour_1", "day_1"],
        postAgeSeconds: 40_000_000,
      }),
    ).toMatchObject({ ageBucket: "mature" });
  });

  it("reports the age it was actually asked about, not the bucket's target", () => {
    // A capture at 34 hours is a 34-hour observation that happens to fall in the
    // day_1 bucket. Reporting the target instead would backdate it.
    const due = instagramSnapshotDueFor({ capturedBuckets: [], postAgeSeconds: 122_400 });
    expect(due).toMatchObject({ ageBucket: "day_1", postAgeSeconds: 122_400 });
  });

  it("floors a fractional age rather than rounding it up into the next bucket", () => {
    expect(instagramSnapshotDueFor({ capturedBuckets: [], postAgeSeconds: 7_200.9 })).toMatchObject(
      { ageBucket: "hour_1", postAgeSeconds: 7_200 },
    );
  });

  it("treats a negative age as the import bucket rather than owing nothing", () => {
    expect(instagramSnapshotDueFor({ capturedBuckets: [], postAgeSeconds: -5 })).toMatchObject({
      ageBucket: "import",
      postAgeSeconds: 0,
    });
  });
});
