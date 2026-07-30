import { loadDatabaseConfig } from "@studio-parallel/config";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { encryptCredential, hashGrantedScopes } from "../../src/credential-encryption.js";
import { createId } from "../../src/id.js";
import {
  commitInstagramDisconnect,
  instagramDisconnectedAction,
  listInstagramAccountSummaries,
} from "../../src/instagram-account.js";
import { purgedCredentialCiphertext } from "../../src/instagram-token.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const masterKey = randomBytes(32);
const grantedScopes = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
const now = new Date("2026-07-31T00:00:00.000Z");
const days = (count: number) => count * 86_400_000;
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";

const actorUserId = "019a0000-0000-7000-8000-0000000009fd";

/**
 * A second real workspace, so cross-workspace isolation is proved against the
 * database rather than against a workspace identifier that does not exist. An
 * absent workspace would fail the audit foreign key and mask whether the update
 * itself was scoped.
 */
const foreignWorkspaceId = "019a0000-0000-7000-8000-0000000009ff";
const foreignUserId = "019a0000-0000-7000-8000-0000000009fe";
const foreignContext = createWorkspaceContext(foreignWorkspaceId);

async function clearAccounts(): Promise<void> {
  await database.auditEvent.deleteMany({ where: { action: instagramDisconnectedAction } });
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);

  // The disposable database is migrated but not seeded, and sibling suites wipe
  // users, so this suite owns the rows the audit foreign keys need.
  await database.workspace.upsert({
    create: {
      id: foreignWorkspaceId,
      name: "Isolation probe workspace",
      slug: "isolation-probe",
    },
    update: {},
    where: { id: foreignWorkspaceId },
  });

  for (const user of [
    { id: actorUserId, workspaceId: developmentWorkspace.id },
    { id: foreignUserId, workspaceId: foreignWorkspaceId },
  ]) {
    await database.internalUser.upsert({
      create: {
        email: `disconnect-${user.id}@studioparallel.invalid`,
        id: user.id,
        role: "ADMIN",
        workspaceId: user.workspaceId,
      },
      update: {},
      where: { workspaceId_id: { id: user.id, workspaceId: user.workspaceId } },
    });
  }
});

beforeEach(async () => {
  await clearAccounts();
});

afterAll(async () => {
  await clearAccounts();
  await database.auditEvent.deleteMany({ where: { workspaceId: foreignWorkspaceId } });
  await database.internalUser.deleteMany({
    where: { id: { in: [actorUserId, foreignUserId] } },
  });
  await database.workspace.deleteMany({ where: { id: foreignWorkspaceId } });
  await database.$disconnect();
});

async function connect(
  overrides: Readonly<{
    connectionStatus?: "ACTIVE" | "DISCONNECTED" | "REAUTHORISATION_REQUIRED";
    credentialStatus?: "ACTIVE" | "REAUTHORISATION_REQUIRED" | "REVOKED";
    expiresAt?: Date | null;
    scopes?: readonly string[];
    withCredential?: boolean;
  }> = {},
): Promise<string> {
  const accountId = createId();
  const scopes = overrides.scopes ?? grantedScopes;
  const expiresAt =
    overrides.expiresAt === undefined ? new Date(now.getTime() + days(60)) : overrides.expiresAt;

  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: overrides.connectionStatus ?? "ACTIVE",
      grantedScopes: [...scopes],
      id: accountId,
      mediaCount: 12,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      tokenExpiresAt: expiresAt,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });

  if (overrides.withCredential === false) return accountId;

  const status = overrides.credentialStatus ?? "ACTIVE";
  const sealed = encryptCredential({
    context: { accountId, integrationType: "INSTAGRAM", workspaceId: developmentWorkspace.id },
    keyVersion: 1,
    masterKey,
    plaintext: "IGAAoriginaltoken",
  });

  await database.integrationCredential.create({
    data: {
      accountId,
      // The check constraint only permits material on an ACTIVE row.
      ciphertext: status === "ACTIVE" ? sealed.ciphertext : purgedCredentialCiphertext,
      expiresAt,
      id: createId(),
      integrationType: "INSTAGRAM",
      issuedAt: new Date(now.getTime() - days(30)),
      keyVersion: 1,
      scopeHash: hashGrantedScopes(scopes),
      status,
      tokenType: "bearer",
      workspaceId: developmentWorkspace.id,
    },
  });

  return accountId;
}

function disconnect(accountId: string, revocation: "FAILED" | "NOT_ATTEMPTED" | "SUCCEEDED") {
  return commitInstagramDisconnect(database, context, {
    accountId,
    actorUserId,
    correlationId,
    occurredAt: now,
    revocation,
  });
}

describe("listInstagramAccountSummaries", () => {
  it("returns nothing for a workspace with no connected account", async () => {
    await expect(listInstagramAccountSummaries(database, context, { now })).resolves.toEqual([]);
  });

  it("projects identity, contract and health without exposing credential material", async () => {
    await connect();

    const [summary] = await listInstagramAccountSummaries(database, context, { now });

    expect(summary).toMatchObject({
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: "ACTIVE",
      mediaCount: 12,
      username: "studioparallel",
    });
    expect(summary?.health.state).toBe("HEALTHY");
    expect(summary?.grantedScopes).toEqual([...grantedScopes]);
    expect(JSON.stringify(summary)).not.toContain("ciphertext");
  });

  it("treats an account with no credential row as revoked rather than healthy", async () => {
    await connect({ expiresAt: null, withCredential: false });

    const [summary] = await listInstagramAccountSummaries(database, context, { now });
    expect(summary?.health.state).toBe("REVOKED");
  });

  it("derives an expiring state from the credential expiry", async () => {
    await connect({ expiresAt: new Date(now.getTime() + days(2)) });

    const [summary] = await listInstagramAccountSummaries(database, context, { now });
    expect(summary?.health.state).toBe("EXPIRING");
  });

  it("reports a downgraded scope set exactly as granted", async () => {
    await connect({ scopes: ["instagram_business_basic"] });

    const [summary] = await listInstagramAccountSummaries(database, context, { now });
    expect(summary?.grantedScopes).toEqual(["instagram_business_basic"]);
  });

  it("reads nothing for another workspace", async () => {
    await connect();

    await expect(listInstagramAccountSummaries(database, foreignContext, { now })).resolves.toEqual(
      [],
    );
  });

  it("prefers the most recently issued credential when several rows exist", async () => {
    const accountId = await connect({ credentialStatus: "REVOKED" });
    await database.integrationCredential.create({
      data: {
        accountId,
        ciphertext: encryptCredential({
          context: {
            accountId,
            integrationType: "INSTAGRAM",
            workspaceId: developmentWorkspace.id,
          },
          keyVersion: 1,
          masterKey,
          plaintext: "IGAAreplacement",
        }).ciphertext,
        expiresAt: new Date(now.getTime() + days(60)),
        id: createId(),
        integrationType: "INSTAGRAM",
        issuedAt: now,
        keyVersion: 1,
        scopeHash: hashGrantedScopes(grantedScopes),
        status: "ACTIVE",
        tokenType: "bearer",
        workspaceId: developmentWorkspace.id,
      },
    });

    const [summary] = await listInstagramAccountSummaries(database, context, { now });
    expect(summary?.health.state).toBe("HEALTHY");
  });
});

describe("commitInstagramDisconnect", () => {
  it("purges the credential material and stops the connection in one transaction", async () => {
    const accountId = await connect();

    await expect(disconnect(accountId, "SUCCEEDED")).resolves.toEqual({
      changed: true,
      revocation: "SUCCEEDED",
    });

    const credential = await database.integrationCredential.findFirst({ where: { accountId } });
    expect(credential?.status).toBe("REVOKED");
    expect(credential?.ciphertext).toBe(purgedCredentialCiphertext);

    const account = await database.instagramAccount.findFirst({ where: { id: accountId } });
    expect(account?.connectionStatus).toBe("DISCONNECTED");
    expect(account?.tokenExpiresAt).toBeNull();
  });

  it("keeps imported posts and sync history", async () => {
    const accountId = await connect();
    await database.syncRun.create({
      data: {
        apiVersion: "v25.0",
        correlationId,
        id: createId(),
        idempotencyKey: `retained-${accountId}`,
        instagramAccountId: accountId,
        startedAt: now,
        state: "SUCCEEDED",
        trigger: "MANUAL",
        workspaceId: developmentWorkspace.id,
      },
    });

    await disconnect(accountId, "SUCCEEDED");

    // Disconnect ends a connection; it is not a deletion.
    await expect(
      database.syncRun.count({ where: { instagramAccountId: accountId } }),
    ).resolves.toBe(1);
    await expect(database.instagramAccount.count({ where: { id: accountId } })).resolves.toBe(1);
  });

  it("is idempotent: a repeat reports no change and writes no second purge", async () => {
    const accountId = await connect();

    await expect(disconnect(accountId, "SUCCEEDED")).resolves.toMatchObject({ changed: true });
    await expect(disconnect(accountId, "NOT_ATTEMPTED")).resolves.toMatchObject({ changed: false });

    const credentials = await database.integrationCredential.findMany({ where: { accountId } });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.ciphertext).toBe(purgedCredentialCiphertext);
  });

  it("audits every attempt, including one that changed nothing", async () => {
    const accountId = await connect();

    await disconnect(accountId, "SUCCEEDED");
    await disconnect(accountId, "NOT_ATTEMPTED");

    const events = await database.auditEvent.findMany({
      orderBy: { outcome: "asc" },
      where: { action: instagramDisconnectedAction, resourceId: accountId },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.outcome)).toEqual(["NO_CHANGE", "SUCCEEDED"]);
    expect(events.every((event) => event.actorUserId === actorUserId)).toBe(true);
  });

  it("records a failed provider revocation while still purging locally", async () => {
    const accountId = await connect();

    await expect(disconnect(accountId, "FAILED")).resolves.toEqual({
      changed: true,
      revocation: "FAILED",
    });

    const credential = await database.integrationCredential.findFirst({ where: { accountId } });
    expect(credential?.ciphertext).toBe(purgedCredentialCiphertext);

    const event = await database.auditEvent.findFirst({
      where: { action: instagramDisconnectedAction, resourceId: accountId },
    });
    // An operator must be able to see that Meta still holds the grant.
    expect(event?.reasonCode).toBe("PROVIDER_REVOCATION_FAILED");
    expect(event?.outcome).toBe("SUCCEEDED");
  });

  it("disconnects an account whose credential was already purged by the token maintainer", async () => {
    const accountId = await connect({
      connectionStatus: "REAUTHORISATION_REQUIRED",
      credentialStatus: "REAUTHORISATION_REQUIRED",
    });

    await expect(disconnect(accountId, "NOT_ATTEMPTED")).resolves.toMatchObject({ changed: true });

    const account = await database.instagramAccount.findFirst({ where: { id: accountId } });
    expect(account?.connectionStatus).toBe("DISCONNECTED");
  });

  it("leaves another workspace's account untouched", async () => {
    const accountId = await connect();

    await expect(
      commitInstagramDisconnect(database, foreignContext, {
        accountId,
        actorUserId: foreignUserId,
        correlationId,
        occurredAt: now,
        revocation: "NOT_ATTEMPTED",
      }),
    ).resolves.toMatchObject({ changed: false });

    const account = await database.instagramAccount.findFirst({ where: { id: accountId } });
    expect(account?.connectionStatus).toBe("ACTIVE");
    const credential = await database.integrationCredential.findFirst({ where: { accountId } });
    expect(credential?.status).toBe("ACTIVE");
    expect(credential?.ciphertext).not.toBe(purgedCredentialCiphertext);
  });

  it("summarises a disconnected account as disconnected and revoked", async () => {
    const accountId = await connect();
    await disconnect(accountId, "SUCCEEDED");

    const [summary] = await listInstagramAccountSummaries(database, context, { now });
    expect(summary).toMatchObject({ accountId, connectionStatus: "DISCONNECTED" });
    expect(summary?.health.state).toBe("REVOKED");
  });
});
