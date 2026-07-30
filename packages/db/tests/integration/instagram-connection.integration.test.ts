import { loadDatabaseConfig } from "@studio-parallel/config";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import {
  decryptCredential,
  encryptCredential,
  hashGrantedScopes,
} from "../../src/credential-encryption.js";
import { createId } from "../../src/id.js";
import { createWorkspaceRepositories, withWorkspaceTransaction } from "../../src/repositories.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const masterKey = randomBytes(32);
const grantedScopes = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
const providerAccountId = "17841400000000001";
const context = createWorkspaceContext(developmentWorkspace.id);
const extraWorkspaceSlugPrefix = "ig-conn-test-";

async function clearConnections(): Promise<void> {
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
  // Workspaces this suite creates are removed by slug, so it never has to delete
  // the shared workspaces whose full dependency chain other suites own.
  await database.workspace.deleteMany({
    where: { slug: { startsWith: extraWorkspaceSlugPrefix } },
  });
}

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clearConnections();
});

afterAll(async () => {
  // Leave no rows that would block another suite from deleting workspaces.
  await clearConnections();
  await database.$disconnect();
});

function seal(
  accountId: string,
  workspaceId: string = developmentWorkspace.id,
  token = "IGAAtokenvalue",
) {
  return encryptCredential({
    context: { accountId, integrationType: "INSTAGRAM", workspaceId },
    keyVersion: 1,
    masterKey,
    plaintext: token,
  });
}

async function connect(
  overrides: { providerAccountId?: string; token?: string } = {},
): Promise<string> {
  return withWorkspaceTransaction(database, context, async (repositories) => {
    const account = await repositories.instagramAccounts.upsertConnected({
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes,
      mediaCount: 48,
      providerAccountId: overrides.providerAccountId ?? providerAccountId,
      tokenExpiresAt: new Date("2026-09-28T00:00:00.000Z"),
      username: "studioparallel",
    });

    const credential = seal(account.id, developmentWorkspace.id, overrides.token);
    await repositories.credentials.activate({
      accountId: account.id,
      ciphertext: credential.ciphertext,
      expiresAt: new Date("2026-09-28T00:00:00.000Z"),
      integrationType: "INSTAGRAM",
      issuedAt: new Date(),
      keyVersion: credential.keyVersion,
      scopeHash: hashGrantedScopes(grantedScopes),
      tokenType: "bearer",
    });

    return account.id;
  });
}

describe("Instagram connection persistence", () => {
  it("activates one account and one usable encrypted credential", async () => {
    const accountId = await connect();
    const repositories = createWorkspaceRepositories(database, context);

    const account = await repositories.instagramAccounts.findByProviderAccountId(providerAccountId);
    expect(account?.id).toBe(accountId);
    expect(account?.accountType).toBe("BUSINESS");
    expect(account?.connectionStatus).toBe("ACTIVE");
    expect(account?.grantedScopes).toEqual([...grantedScopes]);

    const credential = await repositories.credentials.findActive({
      accountId,
      integrationType: "INSTAGRAM",
    });
    expect(credential?.keyVersion).toBe(1);
    expect(credential?.scopeHash).toBe(hashGrantedScopes(grantedScopes));

    // The stored value is ciphertext, and it decrypts only for its own row.
    expect(credential?.ciphertext).not.toContain("IGAAtokenvalue");
    expect(
      decryptCredential({
        context: {
          accountId,
          integrationType: "INSTAGRAM",
          workspaceId: developmentWorkspace.id,
        },
        masterKeys: new Map([[1, masterKey]]),
        sealed: credential?.ciphertext ?? "",
      }),
    ).toBe("IGAAtokenvalue");
  });

  it("is idempotent across reconnects and supersedes the previous credential", async () => {
    const first = await connect({ token: "IGAAfirsttoken" });
    const second = await connect({ token: "IGAAsecondtoken" });

    expect(second).toBe(first);
    expect(await database.instagramAccount.count()).toBe(1);

    // The superseded row is retained for audit rather than deleted.
    expect(await database.integrationCredential.count()).toBe(2);
    expect(
      await database.integrationCredential.count({ where: { accountId: first, status: "ACTIVE" } }),
    ).toBe(1);
    expect(await database.integrationCredential.count({ where: { status: "REVOKED" } })).toBe(1);

    const active = await createWorkspaceRepositories(database, context).credentials.findActive({
      accountId: first,
      integrationType: "INSTAGRAM",
    });
    expect(
      decryptCredential({
        context: {
          accountId: first,
          integrationType: "INSTAGRAM",
          workspaceId: developmentWorkspace.id,
        },
        masterKeys: new Map([[1, masterKey]]),
        sealed: active?.ciphertext ?? "",
      }),
    ).toBe("IGAAsecondtoken");
  });

  it("refuses a second active credential for the same account", async () => {
    const accountId = await connect();
    const credential = seal(accountId);

    // Bypasses the repository's supersede step to prove the database, not the
    // application, is what prevents two usable tokens.
    await expect(
      database.integrationCredential.create({
        data: {
          id: createId(),
          workspaceId: developmentWorkspace.id,
          accountId,
          ciphertext: credential.ciphertext,
          integrationType: "INSTAGRAM",
          issuedAt: new Date(),
          keyVersion: credential.keyVersion,
          scopeHash: hashGrantedScopes(grantedScopes),
          status: "ACTIVE",
          tokenType: "bearer",
        },
      }),
    ).rejects.toThrow();

    expect(await database.integrationCredential.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  it("leaves exactly one active credential when duplicate callbacks race", async () => {
    // Both transactions supersede then insert, so the filtered unique index must
    // fail one of them rather than allowing two active credentials.
    const results = await Promise.allSettled([
      connect({ token: "IGAAraceone" }),
      connect({ token: "IGAAracetwo" }),
    ]);

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await database.instagramAccount.count()).toBe(1);
    expect(await database.integrationCredential.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  it("refuses a credential referencing an account in another workspace", async () => {
    const accountId = await connect();
    const otherWorkspaceId = createId();
    await database.workspace.create({
      data: {
        id: otherWorkspaceId,
        name: "Other workspace",
        slug: `${extraWorkspaceSlugPrefix}${otherWorkspaceId.slice(0, 8)}`,
      },
    });

    const credential = seal(accountId, otherWorkspaceId);

    // The composite (workspace_id, account_id) foreign key must reject this.
    await expect(
      database.integrationCredential.create({
        data: {
          id: createId(),
          workspaceId: otherWorkspaceId,
          accountId,
          ciphertext: credential.ciphertext,
          integrationType: "INSTAGRAM",
          issuedAt: new Date(),
          keyVersion: credential.keyVersion,
          scopeHash: hashGrantedScopes(grantedScopes),
          status: "ACTIVE",
          tokenType: "bearer",
        },
      }),
    ).rejects.toThrow();
  });

  it("does not expose another workspace's account through a scoped repository", async () => {
    await connect();
    const otherWorkspaceId = createId();
    await database.workspace.create({
      data: {
        id: otherWorkspaceId,
        name: "Other workspace",
        slug: `${extraWorkspaceSlugPrefix}${otherWorkspaceId.slice(0, 8)}`,
      },
    });

    const otherRepositories = createWorkspaceRepositories(
      database,
      createWorkspaceContext(otherWorkspaceId),
    );

    expect(
      await otherRepositories.instagramAccounts.findByProviderAccountId(providerAccountId),
    ).toBeNull();
  });

  it("allows the same provider account in two workspaces independently", async () => {
    const first = await connect();
    const otherWorkspaceId = createId();
    await database.workspace.create({
      data: {
        id: otherWorkspaceId,
        name: "Other workspace",
        slug: `${extraWorkspaceSlugPrefix}${otherWorkspaceId.slice(0, 8)}`,
      },
    });

    const otherContext = createWorkspaceContext(otherWorkspaceId);
    const second = await withWorkspaceTransaction(database, otherContext, async (repositories) => {
      const account = await repositories.instagramAccounts.upsertConnected({
        accountType: "CREATOR",
        apiVersion: "v25.0",
        grantedScopes,
        providerAccountId,
      });
      return account.id;
    });

    expect(second).not.toBe(first);
    expect(await database.instagramAccount.count()).toBe(2);
  });
});
