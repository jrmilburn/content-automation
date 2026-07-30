import { loadDatabaseConfig } from "@studio-parallel/config";
import {
  normaliseInstagramMediaItem,
  type NormalisedInstagramMedia,
} from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import {
  commitInstagramMediaPage,
  completeInstagramSyncRun,
  failInstagramSyncRun,
  findInstagramPostByProviderMediaId,
  findInstagramSyncRun,
  instagramSyncRunSucceededForJob,
  listInstagramPosts,
  startInstagramSyncRun,
} from "../../src/instagram-media.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const apiVersion = "v25.0";
const extraWorkspaceSlugPrefix = "ig-media-test-";
const importedAt = new Date("2026-07-30T02:00:00.000Z");
const laterImportedAt = new Date("2026-07-30T03:00:00.000Z");

async function clearMedia(): Promise<void> {
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
  await database.workspace.deleteMany({
    where: { slug: { startsWith: extraWorkspaceSlugPrefix } },
  });
}

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clearMedia();
});

afterAll(async () => {
  await clearMedia();
  await database.$disconnect();
});

async function createAccount(
  overrides: Readonly<{ providerAccountId?: string; workspaceId?: string }> = {},
): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion,
      grantedScopes: ["instagram_business_basic"],
      id,
      providerAccountId: overrides.providerAccountId ?? "17841400000000001",
      username: "studioparallel",
      workspaceId: overrides.workspaceId ?? developmentWorkspace.id,
    },
  });
  return id;
}

async function createWorkspace(): Promise<string> {
  const id = createId();
  await database.workspace.create({
    data: { id, name: "Other workspace", slug: `${extraWorkspaceSlugPrefix}${id.slice(0, 8)}` },
  });
  return id;
}

function media(
  providerMediaId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): NormalisedInstagramMedia {
  const result = normaliseInstagramMediaItem({
    caption: "Behind the scenes",
    id: providerMediaId,
    media_product_type: "REELS",
    media_type: "VIDEO",
    media_url: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE_ONE",
    permalink: `https://www.instagram.com/reel/${providerMediaId}/`,
    thumbnail_url: "https://scontent.cdninstagram.com/v/thumb.jpg?oe=SIGNATURE_ONE",
    timestamp: "2026-07-01T04:12:33+0000",
    ...overrides,
  });

  if (!result.ok) expect.unreachable(`fixture must normalise: ${result.reason}`);
  return result.media;
}

async function startRun(
  accountId: string,
  overrides: Readonly<{ backgroundJobId?: string; idempotencyKey?: string }> = {},
) {
  return startInstagramSyncRun(database, context, {
    apiVersion,
    backgroundJobId: overrides.backgroundJobId ?? null,
    correlationId: createId(),
    horizonStart: new Date("2026-01-01T00:00:00.000Z"),
    idempotencyKey: overrides.idempotencyKey ?? "instagram-bootstrap-sync-1",
    instagramAccountId: accountId,
    startedAt: importedAt,
    trigger: "BOOTSTRAP",
  });
}

describe("Instagram sync run lifecycle", () => {
  it("opens a run and returns the same run for a repeated idempotency key", async () => {
    const accountId = await createAccount();

    const first = await startRun(accountId);
    const second = await startRun(accountId);

    expect(second.id).toBe(first.id);
    expect(second.state).toBe("RUNNING");
    expect(await database.syncRun.count()).toBe(1);
  });

  it("refuses a second concurrent run for the same account and trigger", async () => {
    const accountId = await createAccount();
    await startRun(accountId);

    await expect(
      startRun(accountId, { idempotencyKey: "instagram-bootstrap-sync-2" }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYNC_RUN_ALREADY_ACTIVE" }));

    expect(await database.syncRun.count({ where: { state: "RUNNING" } })).toBe(1);
  });

  it("permits a different trigger to run alongside", async () => {
    const accountId = await createAccount();
    await startRun(accountId);

    const manual = await startInstagramSyncRun(database, context, {
      apiVersion,
      correlationId: createId(),
      idempotencyKey: "instagram-manual-sync-1",
      instagramAccountId: accountId,
      startedAt: importedAt,
      trigger: "MANUAL",
    });

    expect(manual.trigger).toBe("MANUAL");
    expect(await database.syncRun.count({ where: { state: "RUNNING" } })).toBe(2);
  });

  it("refuses a crafted account identifier from another workspace", async () => {
    const otherWorkspaceId = await createWorkspace();
    const foreignAccountId = await createAccount({
      providerAccountId: "17841400000000009",
      workspaceId: otherWorkspaceId,
    });

    await expect(startRun(foreignAccountId)).rejects.toThrowError(
      expect.objectContaining({ code: "SYNC_ACCOUNT_NOT_FOUND", statusCode: 404 }),
    );
    expect(await database.syncRun.count()).toBe(0);
  });

  it("reopens a failed run with its cursor and counters intact", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });
    await failInstagramSyncRun(database, context, {
      failedAt: importedAt,
      failureClass: "TRANSIENT",
      failureCode: "INSTAGRAM_UNAVAILABLE",
      syncRunId: run.id,
    });

    const failed = await findInstagramSyncRun(database, context, run.id);
    expect(failed?.state).toBe("FAILED");
    expect(failed?.failureCode).toBe("INSTAGRAM_UNAVAILABLE");
    expect(failed?.cursor).toBe("QVFIUmZAt");

    const resumed = await startRun(accountId);
    expect(resumed.id).toBe(run.id);
    expect(resumed.state).toBe("RUNNING");
    expect(resumed.cursor).toBe("QVFIUmZAt");
    expect(resumed.itemsImported).toBe(1);
    expect(resumed.failureCode).toBeNull();
  });

  it("records only a safe failure class and code", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await expect(
      failInstagramSyncRun(database, context, {
        failedAt: importedAt,
        failureClass: "TRANSIENT",
        failureCode: "Invalid OAuth access token IGAAsecret",
        syncRunId: run.id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYNC_RUN_FAILURE_CODE_INVALID" }));
  });

  it("completes the run once and stamps the account's last successful sync", async () => {
    const accountId = await createAccount();
    const jobId = createId();
    const run = await startRun(accountId, { backgroundJobId: jobId });

    expect(await instagramSyncRunSucceededForJob(database, context, jobId)).toBe(false);

    await completeInstagramSyncRun(database, context, {
      completedAt: laterImportedAt,
      syncRunId: run.id,
    });

    const completed = await findInstagramSyncRun(database, context, run.id);
    expect(completed?.state).toBe("SUCCEEDED");
    expect(completed?.completedAt?.toISOString()).toBe(laterImportedAt.toISOString());
    expect(await instagramSyncRunSucceededForJob(database, context, jobId)).toBe(true);

    const account = await database.instagramAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.lastSuccessfulSyncAt?.toISOString()).toBe(laterImportedAt.toISOString());

    // A redelivered completion must not reopen or double-stamp the run.
    await expect(
      completeInstagramSyncRun(database, context, {
        completedAt: laterImportedAt,
        syncRunId: run.id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYNC_RUN_NOT_ACTIVE" }));
  });
});

describe("Instagram media page persistence", () => {
  it("imports a page and advances the cursor and counters together", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    const result = await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234"), media("17912345678901235")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
      usageSummary: { "x-app-usage": 22 },
    });

    expect(result).toEqual({ imported: 2, updated: 0 });

    const committed = await findInstagramSyncRun(database, context, run.id);
    expect(committed?.cursor).toBe("QVFIUmZAt");
    expect(committed?.pagesCompleted).toBe(1);
    expect(committed?.itemsSeen).toBe(2);
    expect(committed?.itemsImported).toBe(2);
    expect(committed?.checkpointAt?.toISOString()).toBe(importedAt.toISOString());
    expect(committed?.usageSummary).toEqual({ "x-app-usage": 22 });
  });

  it("classifies a Reel and keeps unknown media inspectable", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [
        media("17912345678901234"),
        media("17912345678901236", { media_product_type: "FEED", media_type: "IMAGE" }),
        media("17912345678901237", { media_product_type: "AD", media_type: "HOLOGRAM" }),
      ],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    const reel = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: accountId,
      providerMediaId: "17912345678901234",
    });
    expect(reel?.mediaKind).toBe("REEL");
    expect(reel?.mediaType).toBe("VIDEO");
    expect(reel?.mediaProductType).toBe("REELS");

    const image = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: accountId,
      providerMediaId: "17912345678901236",
    });
    expect(image?.mediaKind).toBe("IMAGE");

    const unsupported = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: accountId,
      providerMediaId: "17912345678901237",
    });
    expect(unsupported?.mediaKind).toBe("UNSUPPORTED");
    // Retained rather than discarded, so an unknown provider value stays visible.
    expect(unsupported?.mediaProductType).toBe("AD");
    expect(unsupported?.mediaType).toBe("HOLOGRAM");
  });

  it("labels provider URLs as ephemeral and stores no durable media URL", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    const stored = await database.instagramPost.findFirstOrThrow({
      where: { providerMediaId: "17912345678901234" },
    });

    expect(stored.providerThumbnailUrl).toContain("thumb.jpg");
    // The expiring video URL has no column: it survives only inside restricted
    // provenance and can never be mistaken for a stored source asset.
    expect(Object.keys(stored)).not.toContain("mediaUrl");
    expect(Object.keys(stored)).not.toContain("videoAssetId");

    const safe = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: accountId,
      providerMediaId: "17912345678901234",
    });
    // The default read projection carries no caption or raw provider payload.
    expect(Object.keys(safe ?? {})).not.toContain("rawPayload");
    expect(Object.keys(safe ?? {})).not.toContain("caption");
  });

  it("updates the same post when overlapping pages repeat media", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234"), media("17912345678901235")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    const original = await database.instagramPost.findFirstOrThrow({
      where: { providerMediaId: "17912345678901234" },
    });

    const overlap = await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZB",
      importedAt: laterImportedAt,
      invalidCount: 0,
      media: [
        media("17912345678901234", { caption: "Edited caption" }),
        media("17912345678901238"),
      ],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    expect(overlap).toEqual({ imported: 1, updated: 1 });
    expect(await database.instagramPost.count()).toBe(3);

    const updated = await database.instagramPost.findFirstOrThrow({
      where: { providerMediaId: "17912345678901234" },
    });
    // Identity is immutable: the row and its first observation never move.
    expect(updated.id).toBe(original.id);
    expect(updated.firstImportedAt.toISOString()).toBe(importedAt.toISOString());
    expect(updated.lastImportedAt.toISOString()).toBe(laterImportedAt.toISOString());
    expect(updated.caption).toBe("Edited caption");
    expect(updated.rawPayloadHash).not.toBe(original.rawPayloadHash);
  });

  it("keeps the provenance hash stable when only the signed URLs are reissued", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });
    const first = await database.instagramPost.findFirstOrThrow({
      where: { providerMediaId: "17912345678901234" },
    });

    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt: laterImportedAt,
      invalidCount: 0,
      media: [
        media("17912345678901234", {
          media_url: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE_TWO",
          thumbnail_url: "https://scontent.cdninstagram.com/v/thumb.jpg?oe=SIGNATURE_TWO",
        }),
      ],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });
    const refetched = await database.instagramPost.findFirstOrThrow({
      where: { providerMediaId: "17912345678901234" },
    });

    expect(refetched.rawPayloadHash).toBe(first.rawPayloadHash);
  });

  it("isolates and counts an invalid item without losing the page", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    // What the worker does with a page holding one malformed item: the item is
    // dropped and counted, the rest of the page still commits.
    const page = [
      { id: "17912345678901234", media_type: "VIDEO", timestamp: "2026-07-01T04:12:33+0000" },
      { id: "not-a-media-id", media_type: "VIDEO", timestamp: "2026-07-01T04:12:33+0000" },
    ];
    const normalised = page.map((item) => normaliseInstagramMediaItem(item));
    const valid = normalised.flatMap((item) => (item.ok ? [item.media] : []));
    const invalidCount = normalised.filter((item) => !item.ok).length;

    expect(invalidCount).toBe(1);

    await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount,
      media: valid,
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    const committed = await findInstagramSyncRun(database, context, run.id);
    expect(committed?.itemsImported).toBe(1);
    expect(committed?.itemsInvalid).toBe(1);
    expect(committed?.itemsSeen).toBe(2);
    expect(committed?.cursor).toBe("QVFIUmZAt");
    expect(await database.instagramPost.count()).toBe(1);
  });

  it("commits the cursor only when the page's records commit", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    // A cursor the column cannot hold fails the checkpoint update after the
    // posts have been written inside the same transaction. Both must roll back,
    // otherwise a resumed run would skip past media it never stored.
    await expect(
      commitInstagramMediaPage(database, context, {
        cursor: "x".repeat(600),
        importedAt: laterImportedAt,
        invalidCount: 0,
        media: [media("17912345678901239"), media("17912345678901240")],
        rawApiVersion: apiVersion,
        skippedCount: 0,
        stage: "page_committed",
        syncRunId: run.id,
      }),
    ).rejects.toThrow();

    const afterFailure = await findInstagramSyncRun(database, context, run.id);
    expect(afterFailure?.cursor).toBe("QVFIUmZAt");
    expect(afterFailure?.pagesCompleted).toBe(1);
    expect(afterFailure?.itemsImported).toBe(1);
    // The committed page survives and the failed page left nothing behind.
    expect(await database.instagramPost.count()).toBe(1);
    expect(
      await database.instagramPost.count({
        where: { providerMediaId: { in: ["17912345678901239", "17912345678901240"] } },
      }),
    ).toBe(0);
  });

  it("resumes from the checkpoint without duplicating committed media", async () => {
    const accountId = await createAccount();
    const first = await startRun(accountId);

    await commitInstagramMediaPage(database, context, {
      cursor: "QVFIUmZAt",
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234"), media("17912345678901235")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: first.id,
    });

    // Stand in for a crashed attempt: the run is failed and then replayed.
    await failInstagramSyncRun(database, context, {
      failedAt: importedAt,
      failureClass: "TRANSIENT",
      failureCode: "INSTAGRAM_UNAVAILABLE",
      syncRunId: first.id,
    });
    const resumed = await startRun(accountId);
    expect(resumed.cursor).toBe("QVFIUmZAt");

    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt: laterImportedAt,
      invalidCount: 0,
      // The provider overlaps the boundary, so the first item repeats.
      media: [media("17912345678901235"), media("17912345678901241")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: resumed.id,
    });

    const posts = await listInstagramPosts(database, context, { instagramAccountId: accountId });
    expect(posts).toHaveLength(3);
    expect(new Set(posts.map((post) => post.providerMediaId)).size).toBe(3);

    const finished = await findInstagramSyncRun(database, context, resumed.id);
    expect(finished?.pagesCompleted).toBe(2);
    expect(finished?.itemsImported).toBe(3);
    expect(finished?.itemsUpdated).toBe(1);
  });

  it("refuses to commit against a run that is no longer active", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);
    await completeInstagramSyncRun(database, context, {
      completedAt: importedAt,
      syncRunId: run.id,
    });

    await expect(
      commitInstagramMediaPage(database, context, {
        cursor: null,
        importedAt,
        invalidCount: 0,
        media: [media("17912345678901234")],
        rawApiVersion: apiVersion,
        skippedCount: 0,
        stage: "page_committed",
        syncRunId: run.id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYNC_RUN_NOT_ACTIVE" }));

    expect(await database.instagramPost.count()).toBe(0);
  });

  it("rejects an unsafe stage name", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await expect(
      commitInstagramMediaPage(database, context, {
        cursor: null,
        importedAt,
        invalidCount: 0,
        media: [],
        rawApiVersion: apiVersion,
        skippedCount: 0,
        stage: "Committed Page; DROP",
        syncRunId: run.id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "SYNC_RUN_STAGE_INVALID" }));
  });
});

describe("Instagram media ownership boundaries", () => {
  it("keeps the same provider media id separate per account", async () => {
    const accountId = await createAccount();
    const otherAccountId = await createAccount({ providerAccountId: "17841400000000002" });

    const run = await startRun(accountId);
    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });
    await completeInstagramSyncRun(database, context, {
      completedAt: importedAt,
      syncRunId: run.id,
    });

    const otherRun = await startRun(otherAccountId, {
      idempotencyKey: "instagram-bootstrap-sync-2",
    });
    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: otherRun.id,
    });

    expect(await database.instagramPost.count()).toBe(2);

    const mine = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: accountId,
      providerMediaId: "17912345678901234",
    });
    const theirs = await findInstagramPostByProviderMediaId(database, context, {
      instagramAccountId: otherAccountId,
      providerMediaId: "17912345678901234",
    });

    expect(mine?.id).not.toBe(theirs?.id);
    expect(mine?.instagramAccountId).toBe(accountId);
    expect(theirs?.instagramAccountId).toBe(otherAccountId);
  });

  it("does not return another workspace's posts through a scoped read", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);
    await commitInstagramMediaPage(database, context, {
      cursor: null,
      importedAt,
      invalidCount: 0,
      media: [media("17912345678901234")],
      rawApiVersion: apiVersion,
      skippedCount: 0,
      stage: "page_committed",
      syncRunId: run.id,
    });

    const otherContext = createWorkspaceContext(await createWorkspace());

    expect(
      await findInstagramPostByProviderMediaId(database, otherContext, {
        instagramAccountId: accountId,
        providerMediaId: "17912345678901234",
      }),
    ).toBeNull();
    expect(
      await listInstagramPosts(database, otherContext, { instagramAccountId: accountId }),
    ).toHaveLength(0);
  });

  it("refuses a post that claims an account in another workspace", async () => {
    const accountId = await createAccount();
    const otherWorkspaceId = await createWorkspace();

    // The composite (workspace_id, instagram_account_id) foreign key, not the
    // application, is what prevents this.
    await expect(
      database.instagramPost.create({
        data: {
          firstImportedAt: importedAt,
          id: createId(),
          instagramAccountId: accountId,
          lastImportedAt: importedAt,
          mediaKind: "REEL",
          mediaType: "VIDEO",
          providerMediaId: "17912345678901234",
          publishedAt: importedAt,
          rawApiVersion: apiVersion,
          rawPayload: {},
          rawPayloadHash: "0".repeat(64),
          rawRetrievedAt: importedAt,
          workspaceId: otherWorkspaceId,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("Instagram media database constraints", () => {
  it("enforces one running run per account and trigger in the database", async () => {
    const indexes = await database.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'sync_runs' AND indexname = 'sync_runs_one_running_per_account_trigger'
    `;
    expect(indexes).toHaveLength(1);

    const accountId = await createAccount();
    const run = await startRun(accountId);

    // Bypasses the repository to prove the index, not the application, blocks it.
    await expect(
      database.syncRun.create({
        data: {
          apiVersion,
          correlationId: createId(),
          id: createId(),
          idempotencyKey: "instagram-bootstrap-sync-bypass",
          instagramAccountId: accountId,
          startedAt: importedAt,
          state: "RUNNING",
          trigger: "BOOTSTRAP",
          workspaceId: developmentWorkspace.id,
        },
      }),
    ).rejects.toThrow();

    expect(await database.syncRun.count({ where: { id: run.id } })).toBe(1);
  });

  it("refuses a negative counter", async () => {
    const accountId = await createAccount();
    const run = await startRun(accountId);

    await expect(
      database.syncRun.update({ data: { itemsImported: -1 }, where: { id: run.id } }),
    ).rejects.toThrow();
  });

  it("refuses a post imported before it first existed", async () => {
    const accountId = await createAccount();

    await expect(
      database.instagramPost.create({
        data: {
          firstImportedAt: laterImportedAt,
          id: createId(),
          instagramAccountId: accountId,
          lastImportedAt: importedAt,
          mediaKind: "REEL",
          mediaType: "VIDEO",
          providerMediaId: "17912345678901234",
          publishedAt: importedAt,
          rawApiVersion: apiVersion,
          rawPayload: {},
          rawPayloadHash: "0".repeat(64),
          rawRetrievedAt: importedAt,
          workspaceId: developmentWorkspace.id,
        },
      }),
    ).rejects.toThrow();
  });
});
