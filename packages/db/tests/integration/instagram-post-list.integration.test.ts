import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import { instagramPostPageSize, loadInstagramPostList } from "../../src/instagram-post-list.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const now = new Date("2026-07-31T00:00:00.000Z");
const days = (count: number) => count * 86_400_000;

const foreignWorkspaceId = "019a0000-0000-7000-8000-0000000008ff";
const foreignContext = createWorkspaceContext(foreignWorkspaceId);

let accountId: string;
let secondAccountId: string;
let foreignAccountId: string;

async function clearPosts(): Promise<void> {
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

async function createAccount(workspaceId: string, username: string): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes: ["instagram_business_basic"],
      id,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      username,
      workspaceId,
    },
  });
  return id;
}

async function createPost(
  input: Readonly<{
    accountId: string;
    caption?: string | null;
    mediaKind?: "CAROUSEL_ALBUM" | "IMAGE" | "REEL" | "UNSUPPORTED" | "VIDEO";
    permalink?: string | null;
    publishedAt: Date;
    thumbnail?: string | null;
    workspaceId?: string;
  }>,
): Promise<string> {
  const id = createId();
  const workspaceId = input.workspaceId ?? developmentWorkspace.id;
  await database.instagramPost.create({
    data: {
      caption: input.caption === undefined ? "A studio lighting walkthrough" : input.caption,
      firstImportedAt: now,
      id,
      instagramAccountId: input.accountId,
      lastImportedAt: now,
      mediaKind: input.mediaKind ?? "REEL",
      mediaProductType: (input.mediaKind ?? "REEL") === "REEL" ? "REELS" : "FEED",
      mediaType: "VIDEO",
      permalink:
        input.permalink === undefined ? "https://www.instagram.com/reel/abc/" : input.permalink,
      providerMediaId: `media-${id.slice(-12)}`,
      providerThumbnailUrl:
        input.thumbnail === undefined ? "https://scontent.example/signed.jpg" : input.thumbnail,
      publishedAt: input.publishedAt,
      rawApiVersion: "v25.0",
      rawPayload: { id: `media-${id.slice(-12)}` },
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: now,
      workspaceId,
    },
  });
  return id;
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
  await database.workspace.upsert({
    create: { id: foreignWorkspaceId, name: "Foreign posts", slug: "foreign-posts" },
    update: {},
    where: { id: foreignWorkspaceId },
  });
});

beforeEach(async () => {
  await clearPosts();
  accountId = await createAccount(developmentWorkspace.id, "studioparallel");
  secondAccountId = await createAccount(developmentWorkspace.id, "secondaccount");
  foreignAccountId = await createAccount(foreignWorkspaceId, "foreignaccount");
});

afterAll(async () => {
  await clearPosts();
  await database.workspace.deleteMany({ where: { id: foreignWorkspaceId } });
  await database.$disconnect();
});

describe("loadInstagramPostList scoping", () => {
  it("returns nothing when the workspace has no posts", async () => {
    const list = await loadInstagramPostList(database, context, {}, null, now);

    expect(list.posts).toEqual([]);
    expect(list.totalCount).toBe(0);
    expect(list.nextCursor).toBeNull();
  });

  it("never returns another workspace's posts", async () => {
    await createPost({ accountId, publishedAt: new Date(now.getTime() - days(1)) });
    await createPost({
      accountId: foreignAccountId,
      publishedAt: now,
      workspaceId: foreignWorkspaceId,
    });

    const list = await loadInstagramPostList(database, context, {}, null, now);
    expect(list.totalCount).toBe(1);
    expect(list.posts[0]?.instagramAccountId).toBe(accountId);

    const foreign = await loadInstagramPostList(database, foreignContext, {}, null, now);
    expect(foreign.totalCount).toBe(1);
    expect(foreign.posts[0]?.instagramAccountId).toBe(foreignAccountId);
  });

  it("cannot be made to read across workspaces with another workspace's account id", async () => {
    await createPost({
      accountId: foreignAccountId,
      publishedAt: now,
      workspaceId: foreignWorkspaceId,
    });

    // The account filter is applied on top of the workspace scope, never instead
    // of it, so a crafted account identifier reads nothing.
    const list = await loadInstagramPostList(
      database,
      context,
      { instagramAccountId: foreignAccountId },
      null,
      now,
    );

    expect(list.posts).toEqual([]);
    expect(list.totalCount).toBe(0);
  });

  it("short-circuits an impossible filter without querying", async () => {
    await createPost({ accountId, publishedAt: now });

    const list = await loadInstagramPostList(
      database,
      context,
      { matchesNothing: true },
      null,
      now,
    );
    expect(list.totalCount).toBe(0);
  });

  it("never selects the restricted raw payload", async () => {
    await createPost({ accountId, publishedAt: now });

    const list = await loadInstagramPostList(database, context, {}, null, now);
    expect(JSON.stringify(list)).not.toContain("rawPayload");
    expect(list.posts[0]).not.toHaveProperty("rawPayload");
  });
});

describe("loadInstagramPostList filtering", () => {
  it("filters by media kind", async () => {
    await createPost({ accountId, mediaKind: "REEL", publishedAt: now });
    await createPost({
      accountId,
      mediaKind: "IMAGE",
      publishedAt: new Date(now.getTime() - 1000),
    });

    const reels = await loadInstagramPostList(database, context, { mediaKind: "REEL" }, null, now);
    expect(reels.totalCount).toBe(1);
    expect(reels.posts[0]?.mediaKind).toBe("REEL");
  });

  it("filters by account within the workspace", async () => {
    await createPost({ accountId, publishedAt: now });
    await createPost({ accountId: secondAccountId, publishedAt: new Date(now.getTime() - 1000) });

    const list = await loadInstagramPostList(
      database,
      context,
      { instagramAccountId: secondAccountId },
      null,
      now,
    );
    expect(list.totalCount).toBe(1);
    expect(list.posts[0]?.instagramAccountId).toBe(secondAccountId);
  });

  it("filters by publication date range inclusively", async () => {
    await createPost({ accountId, publishedAt: new Date("2026-07-01T09:00:00.000Z") });
    await createPost({ accountId, publishedAt: new Date("2026-07-15T09:00:00.000Z") });
    await createPost({ accountId, publishedAt: new Date("2026-07-30T09:00:00.000Z") });

    const list = await loadInstagramPostList(
      database,
      context,
      {
        publishedFrom: new Date("2026-07-01T00:00:00.000Z"),
        publishedTo: new Date("2026-07-15T23:59:59.999Z"),
      },
      null,
      now,
    );

    expect(list.totalCount).toBe(2);
  });

  it("searches captions case-insensitively and skips captionless posts", async () => {
    await createPost({ accountId, caption: "Studio LIGHTING walkthrough", publishedAt: now });
    await createPost({
      accountId,
      caption: null,
      publishedAt: new Date(now.getTime() - 1000),
    });
    await createPost({
      accountId,
      caption: "Winter campaign",
      publishedAt: new Date(now.getTime() - 2000),
    });

    const list = await loadInstagramPostList(database, context, { search: "lighting" }, null, now);
    expect(list.totalCount).toBe(1);
    expect(list.posts[0]?.caption).toContain("LIGHTING");
  });

  it("combines filters conjunctively", async () => {
    await createPost({ accountId, caption: "lighting reel", mediaKind: "REEL", publishedAt: now });
    await createPost({
      accountId,
      caption: "lighting image",
      mediaKind: "IMAGE",
      publishedAt: new Date(now.getTime() - 1000),
    });

    const list = await loadInstagramPostList(
      database,
      context,
      { mediaKind: "REEL", search: "lighting" },
      null,
      now,
    );
    expect(list.totalCount).toBe(1);
  });
});

describe("loadInstagramPostList pagination", () => {
  async function seed(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await createPost({
        accountId,
        publishedAt: new Date(now.getTime() - days(index)),
      });
    }
  }

  it("returns a full page and a cursor when more remain", async () => {
    await seed(instagramPostPageSize + 5);

    const first = await loadInstagramPostList(database, context, {}, null, now);
    expect(first.posts).toHaveLength(instagramPostPageSize);
    expect(first.nextCursor).not.toBeNull();
    // The count is the whole matching set, not the page.
    expect(first.totalCount).toBe(instagramPostPageSize + 5);
  });

  it("returns no cursor on the last page", async () => {
    await seed(3);

    const list = await loadInstagramPostList(database, context, {}, null, now);
    expect(list.posts).toHaveLength(3);
    expect(list.nextCursor).toBeNull();
  });

  it("continues from the cursor without repeating or skipping a post", async () => {
    await seed(instagramPostPageSize + 5);

    const first = await loadInstagramPostList(database, context, {}, null, now);
    const second = await loadInstagramPostList(database, context, {}, first.nextCursor, now);

    expect(second.posts).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.posts, ...second.posts].map((post) => post.id);
    expect(new Set(ids).size).toBe(instagramPostPageSize + 5);
  });

  it("orders newest first across the whole set", async () => {
    await seed(instagramPostPageSize + 5);

    const first = await loadInstagramPostList(database, context, {}, null, now);
    const second = await loadInstagramPostList(database, context, {}, first.nextCursor, now);
    const published = [...first.posts, ...second.posts].map((post) => post.publishedAt);

    expect(published).toEqual([...published].sort().reverse());
  });

  it("does not shift rows when a newer post is imported mid-page", async () => {
    await seed(instagramPostPageSize + 5);
    const first = await loadInstagramPostList(database, context, {}, null, now);

    // A sync landing between page requests is the normal case, not an edge one.
    await createPost({ accountId, publishedAt: new Date(now.getTime() + days(1)) });

    const second = await loadInstagramPostList(database, context, {}, first.nextCursor, now);
    const overlap = second.posts.filter((post) =>
      first.posts.some((earlier) => earlier.id === post.id),
    );

    // Offset pagination would have repeated a row here.
    expect(overlap).toEqual([]);
  });

  it("treats an unreadable cursor as the first page rather than failing", async () => {
    await seed(3);

    const list = await loadInstagramPostList(database, context, {}, "not-a-cursor", now);
    expect(list.posts).toHaveLength(3);
  });

  it("keeps a tie in publication time stable across pages", async () => {
    const shared = new Date("2026-07-20T00:00:00.000Z");
    for (let index = 0; index < instagramPostPageSize + 2; index += 1) {
      await createPost({ accountId, publishedAt: shared });
    }

    const first = await loadInstagramPostList(database, context, {}, null, now);
    const second = await loadInstagramPostList(database, context, {}, first.nextCursor, now);
    const ids = [...first.posts, ...second.posts].map((post) => post.id);

    // publishedAt alone is not unique, so the id tiebreaker is what prevents a
    // row appearing on both pages.
    expect(new Set(ids).size).toBe(instagramPostPageSize + 2);
  });
});

describe("loadInstagramPostList projection", () => {
  it("drops a non-HTTPS permalink and thumbnail rather than rendering them", async () => {
    await createPost({
      accountId,
      permalink: "http://insecure.example/post",
      publishedAt: now,
      thumbnail: "http://insecure.example/thumb.jpg",
    });

    const list = await loadInstagramPostList(database, context, {}, null, now);
    expect(list.posts[0]?.permalink).toBeNull();
    expect(list.posts[0]?.providerThumbnailUrl).toBeNull();
  });

  it("serialises timestamps as ISO strings", async () => {
    await createPost({ accountId, publishedAt: new Date("2026-07-29T22:15:00.000Z") });

    const list = await loadInstagramPostList(database, context, {}, null, now);
    expect(list.posts[0]?.publishedAt).toBe("2026-07-29T22:15:00.000Z");
    expect(typeof list.posts[0]?.lastImportedAt).toBe("string");
  });
});
