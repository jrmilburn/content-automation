import { loadDatabaseConfig } from "@studio-parallel/config";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { encryptCredential, hashGrantedScopes } from "../../src/credential-encryption.js";
import { createId } from "../../src/id.js";
import {
  listInstagramCredentialsDueForMaintenance,
  loadInstagramConnectionHealth,
  loadInstagramCredentialForMaintenance,
  purgedCredentialCiphertext,
  recordInstagramCredentialValidation,
  requireInstagramReauthorisation,
  rotateInstagramCredential,
} from "../../src/instagram-token.js";
import { createWorkspaceRepositories, withWorkspaceTransaction } from "../../src/repositories.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const masterKey = randomBytes(32);
const grantedScopes = ["instagram_business_basic", "instagram_business_manage_insights"] as const;
const now = new Date("2026-07-31T00:00:00.000Z");
const days = (count: number) => count * 86_400_000;

async function clearTokens(): Promise<void> {
  await database.auditEvent.deleteMany({ where: { actorService: "token-maintainer" } });
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clearTokens();
});

afterAll(async () => {
  await clearTokens();
  await database.$disconnect();
});

function seal(accountId: string, plaintext: string) {
  return encryptCredential({
    context: { accountId, integrationType: "INSTAGRAM", workspaceId: developmentWorkspace.id },
    keyVersion: 1,
    masterKey,
    plaintext,
  });
}

async function connect(
  overrides: Readonly<{
    connectionStatus?: "ACTIVE" | "REAUTHORISATION_REQUIRED";
    expiresAt?: Date | null;
    issuedAt?: Date;
    token?: string;
  }> = {},
): Promise<Readonly<{ accountId: string; credentialId: string }>> {
  const accountId = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: overrides.connectionStatus ?? "ACTIVE",
      grantedScopes: [...grantedScopes],
      id: accountId,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      tokenExpiresAt:
        overrides.expiresAt === undefined
          ? new Date(now.getTime() + days(60))
          : overrides.expiresAt,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });

  const sealed = seal(accountId, overrides.token ?? "IGAAoriginaltoken");
  const credential = await database.integrationCredential.create({
    data: {
      accountId,
      ciphertext: sealed.ciphertext,
      expiresAt:
        overrides.expiresAt === undefined
          ? new Date(now.getTime() + days(60))
          : overrides.expiresAt,
      id: createId(),
      integrationType: "INSTAGRAM",
      issuedAt: overrides.issuedAt ?? new Date(now.getTime() - days(30)),
      keyVersion: 1,
      scopeHash: hashGrantedScopes(grantedScopes),
      status: "ACTIVE",
      tokenType: "bearer",
      workspaceId: developmentWorkspace.id,
    },
  });

  return Object.freeze({ accountId, credentialId: credential.id });
}

describe("Instagram credential rotation", () => {
  it("replaces material in place, keeping the row and clearing the last error", async () => {
    const { accountId, credentialId } = await connect();
    await database.integrationCredential.update({
      data: { lastValidationErrorClass: "TRANSIENT" },
      where: { id: credentialId },
    });

    const sealed = seal(accountId, "IGAArefreshed");
    const refreshedAt = new Date(now.getTime() + days(1));
    const expiresAt = new Date(now.getTime() + days(61));

    const rotated = await rotateInstagramCredential(database, context, {
      ciphertext: sealed.ciphertext,
      credentialId,
      expectedRefreshedAt: null,
      expiresAt,
      keyVersion: sealed.keyVersion,
      refreshedAt,
      tokenType: "bearer",
    });

    expect(rotated).toBe(true);

    const credential = await database.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    // Rotation in place leaves no second, decryptable copy behind.
    expect(await database.integrationCredential.count()).toBe(1);
    expect(credential.ciphertext).toBe(sealed.ciphertext);
    expect(credential.status).toBe("ACTIVE");
    expect(credential.refreshedAt?.toISOString()).toBe(refreshedAt.toISOString());
    expect(credential.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(credential.lastValidationErrorClass).toBeNull();

    const account = await database.instagramAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.tokenExpiresAt?.toISOString()).toBe(expiresAt.toISOString());
  });

  it("lets exactly one of two concurrent workers rotate", async () => {
    const { accountId, credentialId } = await connect();

    const attempt = (token: string, at: Date) =>
      rotateInstagramCredential(database, context, {
        ciphertext: seal(accountId, token).ciphertext,
        credentialId,
        expectedRefreshedAt: null,
        expiresAt: new Date(now.getTime() + days(61)),
        keyVersion: 1,
        refreshedAt: at,
        tokenType: "bearer",
      });

    const results = await Promise.all([
      attempt("IGAAworkerone", new Date(now.getTime() + days(1))),
      attempt("IGAAworkertwo", new Date(now.getTime() + days(1) + 1_000)),
    ]);

    // The compare-and-swap must let one through and tell the other it lost.
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await database.integrationCredential.count({ where: { status: "ACTIVE" } })).toBe(1);
  });

  it("refuses to overwrite a token another worker already refreshed", async () => {
    const { accountId, credentialId } = await connect();
    const firstRefreshAt = new Date(now.getTime() + days(1));
    const newest = seal(accountId, "IGAAnewest").ciphertext;

    await rotateInstagramCredential(database, context, {
      ciphertext: newest,
      credentialId,
      expectedRefreshedAt: null,
      expiresAt: new Date(now.getTime() + days(61)),
      keyVersion: 1,
      refreshedAt: firstRefreshAt,
      tokenType: "bearer",
    });

    // A worker still holding the pre-rotation view must not win.
    const stale = await rotateInstagramCredential(database, context, {
      ciphertext: seal(accountId, "IGAAstale").ciphertext,
      credentialId,
      expectedRefreshedAt: null,
      expiresAt: new Date(now.getTime() + days(45)),
      keyVersion: 1,
      refreshedAt: new Date(now.getTime() + days(2)),
      tokenType: "bearer",
    });

    expect(stale).toBe(false);

    const credential = await database.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    // The newer token survives untouched rather than being rolled back.
    expect(credential.ciphertext).toBe(newest);
    expect(credential.refreshedAt?.toISOString()).toBe(firstRefreshAt.toISOString());
    expect(credential.expiresAt?.toISOString()).toBe(
      new Date(now.getTime() + days(61)).toISOString(),
    );
  });

  it("refuses to write empty material", async () => {
    const { credentialId } = await connect();

    await expect(
      rotateInstagramCredential(database, context, {
        ciphertext: "",
        credentialId,
        expectedRefreshedAt: null,
        expiresAt: null,
        keyVersion: 1,
        refreshedAt: now,
        tokenType: "bearer",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "CREDENTIAL_CIPHERTEXT_EMPTY" }));
  });

  it("does not rotate a credential in another workspace", async () => {
    const { accountId, credentialId } = await connect();
    const otherContext = createWorkspaceContext(createId());

    const rotated = await rotateInstagramCredential(database, otherContext, {
      ciphertext: seal(accountId, "IGAAcrafted").ciphertext,
      credentialId,
      expectedRefreshedAt: null,
      expiresAt: null,
      keyVersion: 1,
      refreshedAt: now,
      tokenType: "bearer",
    });

    expect(rotated).toBe(false);
  });
});

describe("Instagram reauthorisation", () => {
  it("stops provider work, purges the token and audits the reason", async () => {
    const { accountId, credentialId } = await connect();

    await requireInstagramReauthorisation(database, context, {
      accountId,
      correlationId: createId(),
      credentialId,
      occurredAt: now,
      reasonCode: "TOKEN_EXPIRED",
    });

    const credential = await database.integrationCredential.findUniqueOrThrow({
      where: { id: credentialId },
    });
    expect(credential.status).toBe("REAUTHORISATION_REQUIRED");
    // A revoked token has no further legitimate use, so nothing decryptable stays.
    expect(credential.ciphertext).toBe(purgedCredentialCiphertext);
    expect(credential.lastValidationErrorClass).toBe("TOKEN_EXPIRED");

    const account = await database.instagramAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.connectionStatus).toBe("REAUTHORISATION_REQUIRED");

    // This is what actually stops sync: the handler finds no active credential.
    const active = await createWorkspaceRepositories(database, context).credentials.findActive({
      accountId,
      integrationType: "INSTAGRAM",
    });
    expect(active).toBeNull();

    const audit = await database.auditEvent.findFirstOrThrow({
      where: { action: "instagram.token.reauthorisation_required", resourceId: accountId },
    });
    expect(audit.outcome).toBe("BLOCKED");
    expect(audit.reasonCode).toBe("TOKEN_EXPIRED");
    expect(audit.actorService).toBe("token-maintainer");
  });

  it("refuses an unsafe reason code that could carry provider text", async () => {
    const { accountId, credentialId } = await connect();

    await expect(
      requireInstagramReauthorisation(database, context, {
        accountId,
        correlationId: createId(),
        credentialId,
        occurredAt: now,
        reasonCode: "Invalid OAuth token IGAAsecret",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "CREDENTIAL_ERROR_CLASS_INVALID" }));
  });
});

describe("Instagram reconnect", () => {
  it("replaces the credential, purges the old material and keeps imported history", async () => {
    const { accountId } = await connect({ token: "IGAAoriginaltoken" });

    await database.instagramPost.create({
      data: {
        firstImportedAt: now,
        id: createId(),
        instagramAccountId: accountId,
        lastImportedAt: now,
        mediaKind: "REEL",
        mediaType: "VIDEO",
        providerMediaId: "17912345678901234",
        publishedAt: now,
        rawApiVersion: "v25.0",
        rawPayload: {},
        rawPayloadHash: "0".repeat(64),
        rawRetrievedAt: now,
        workspaceId: developmentWorkspace.id,
      },
    });

    const replacement = seal(accountId, "IGAAreconnected");
    await withWorkspaceTransaction(database, context, async (repositories) =>
      repositories.credentials.activate({
        accountId,
        ciphertext: replacement.ciphertext,
        expiresAt: new Date(now.getTime() + days(60)),
        integrationType: "INSTAGRAM",
        issuedAt: now,
        keyVersion: replacement.keyVersion,
        scopeHash: hashGrantedScopes(grantedScopes),
        tokenType: "bearer",
      }),
    );

    const active = await createWorkspaceRepositories(database, context).credentials.findActive({
      accountId,
      integrationType: "INSTAGRAM",
    });
    expect(active?.ciphertext).toBe(replacement.ciphertext);

    // The superseded row is kept for audit but holds nothing usable.
    const superseded = await database.integrationCredential.findMany({
      where: { accountId, status: "REVOKED" },
    });
    expect(superseded).toHaveLength(1);
    expect(superseded[0]?.ciphertext).toBe(purgedCredentialCiphertext);

    // Reconnecting must never cost the account its imported media.
    expect(await database.instagramPost.count({ where: { instagramAccountId: accountId } })).toBe(
      1,
    );
  });
});

describe("Instagram credential database invariants", () => {
  it("refuses to retain material on a superseded credential", async () => {
    const { credentialId } = await connect();

    await expect(
      database.integrationCredential.update({
        data: { status: "REVOKED" },
        where: { id: credentialId },
      }),
    ).rejects.toThrow();
  });

  it("refuses an active credential with no material", async () => {
    const { credentialId } = await connect();

    await expect(
      database.integrationCredential.update({
        data: { ciphertext: purgedCredentialCiphertext },
        where: { id: credentialId },
      }),
    ).rejects.toThrow();
  });

  it("declares the invariant as a check constraint", async () => {
    const constraints = await database.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname = 'integration_credentials_material_only_when_active'
    `;
    expect(constraints).toHaveLength(1);
  });
});

describe("Instagram connection health", () => {
  it("reports safe health without exposing credential material", async () => {
    const { accountId } = await connect({ expiresAt: new Date(now.getTime() + days(3)) });

    const health = await loadInstagramConnectionHealth(database, context, { accountId, now });

    expect(health?.health.state).toBe("EXPIRING");
    expect(health?.grantedScopes).toEqual([...grantedScopes]);
    expect(health?.username).toBe("studioparallel");
    // The projection cannot express a token, so nothing can render one.
    expect(JSON.stringify(health)).not.toContain("IGAA");
    expect(Object.keys(health ?? {})).not.toContain("ciphertext");
  });

  it("records a validation without touching material", async () => {
    const { accountId, credentialId } = await connect();
    const validatedAt = new Date(now.getTime() + days(1));

    await recordInstagramCredentialValidation(database, context, { credentialId, validatedAt });

    const health = await loadInstagramConnectionHealth(database, context, { accountId, now });
    expect(health?.lastValidatedAt?.toISOString()).toBe(validatedAt.toISOString());
  });

  it("returns nothing for an account in another workspace", async () => {
    const { accountId } = await connect();
    const otherContext = createWorkspaceContext(createId());

    expect(
      await loadInstagramConnectionHealth(database, otherContext, { accountId, now }),
    ).toBeNull();
    expect(
      await loadInstagramCredentialForMaintenance(database, otherContext, { accountId }),
    ).toBeNull();
  });
});

describe("Instagram maintenance sweep", () => {
  it("selects credentials near expiry and those with an unknown expiry", async () => {
    const due = await connect({ expiresAt: new Date(now.getTime() + days(3)) });
    const unknown = await connect({ expiresAt: null });
    const healthy = await connect({ expiresAt: new Date(now.getTime() + days(59)) });

    const selected = await listInstagramCredentialsDueForMaintenance(database, {
      dueBefore: new Date(now.getTime() + days(15)),
      limit: 50,
    });
    const credentialIds = selected.map((credential) => credential.credentialId);

    expect(credentialIds).toContain(due.credentialId);
    // An unknown expiry must be probed, not assumed to be far away.
    expect(credentialIds).toContain(unknown.credentialId);
    expect(credentialIds).not.toContain(healthy.credentialId);
  });

  it("ignores accounts that already need reconnecting", async () => {
    const blocked = await connect({
      connectionStatus: "REAUTHORISATION_REQUIRED",
      expiresAt: new Date(now.getTime() + days(1)),
    });

    const selected = await listInstagramCredentialsDueForMaintenance(database, {
      dueBefore: new Date(now.getTime() + days(15)),
      limit: 50,
    });

    expect(selected.map((credential) => credential.credentialId)).not.toContain(
      blocked.credentialId,
    );
  });

  it("returns only identifiers, never material", async () => {
    await connect({ expiresAt: new Date(now.getTime() + days(1)) });

    const selected = await listInstagramCredentialsDueForMaintenance(database, {
      dueBefore: new Date(now.getTime() + days(15)),
      limit: 50,
    });

    expect(selected.length).toBeGreaterThan(0);
    expect(Object.keys(selected[0] ?? {}).sort()).toEqual([
      "accountId",
      "credentialId",
      "workspaceId",
    ]);
  });
});
