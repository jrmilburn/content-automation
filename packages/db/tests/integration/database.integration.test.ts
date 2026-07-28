import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import {
  authoriseOidcIdentity,
  findActiveSessionPrincipal,
  setInternalUserStatus,
} from "../../src/auth.js";
import {
  requireWorkspaceResource,
  WorkspaceResourceNotFoundError,
} from "../../src/authorisation.js";
import { loadWorkspaceDashboardFoundation } from "../../src/dashboard.js";
import { isUuidV7 } from "../../src/id.js";
import { createWorkspaceRepositories, withWorkspaceTransaction } from "../../src/repositories.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await database.auditEvent.deleteMany();
  await database.systemSetting.deleteMany();
  await database.internalUser.deleteMany();
  await database.workspace.deleteMany({
    where: { id: { not: developmentWorkspace.id } },
  });
});

afterAll(async () => {
  await database.$disconnect();
});

describe("database foundation", () => {
  it("seeds exactly one non-PII development workspace", async () => {
    await expect(database.workspace.findMany()).resolves.toEqual([
      expect.objectContaining({
        id: developmentWorkspace.id,
        name: developmentWorkspace.name,
        slug: developmentWorkspace.slug,
        timezone: developmentWorkspace.timezone,
      }),
    ]);
    await expect(database.internalUser.count()).resolves.toBe(0);
  });

  it("scopes user lookups to the required workspace context", async () => {
    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01900000-0000-7000-8000-000000000002",
        name: "Isolation Test Workspace",
        slug: "isolation-test",
      },
    });
    const primary = createWorkspaceRepositories(
      database,
      createWorkspaceContext(developmentWorkspace.id),
    );
    const secondary = createWorkspaceRepositories(
      database,
      createWorkspaceContext(secondWorkspace.id),
    );
    const user = await secondary.users.create({
      email: "isolated@example.invalid",
      oidcSubject: "oidc-isolated",
    });

    expect(isUuidV7(user.id)).toBe(true);
    await expect(primary.users.findById(user.id)).resolves.toBeNull();
    await expect(secondary.users.findById(user.id)).resolves.toMatchObject({
      id: user.id,
      workspaceId: secondWorkspace.id,
    });
  });

  it("loads dashboard foundations only through the requested active workspace scope", async () => {
    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01900000-0000-7000-8000-000000000003",
        name: "Dashboard Isolation Workspace",
        slug: "dashboard-isolation",
      },
    });
    const checkedAt = new Date("2026-07-28T02:00:00.000Z");

    await expect(
      loadWorkspaceDashboardFoundation(
        database,
        createWorkspaceContext(secondWorkspace.id),
        checkedAt,
      ),
    ).resolves.toEqual({
      checkedAt,
      workspaceId: secondWorkspace.id,
      workspaceUpdatedAt: secondWorkspace.updatedAt,
    });
    await database.workspace.update({
      data: { status: "DISABLED" },
      where: { id: secondWorkspace.id },
    });
    await expect(
      loadWorkspaceDashboardFoundation(database, createWorkspaceContext(secondWorkspace.id)),
    ).resolves.toBeNull();
    await expect(
      loadWorkspaceDashboardFoundation(database, createWorkspaceContext(developmentWorkspace.id)),
    ).resolves.toMatchObject({ workspaceId: developmentWorkspace.id });
  });

  it("enforces normalized identity uniqueness within a workspace", async () => {
    const repositories = createWorkspaceRepositories(
      database,
      createWorkspaceContext(developmentWorkspace.id),
    );

    await repositories.users.create({
      email: "Team.Member@Example.invalid",
      oidcSubject: "oidc-primary",
    });

    await expect(
      repositories.users.create({
        email: "team.member@example.invalid",
        oidcSubject: "oidc-secondary",
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rolls back workspace-scoped transactions atomically", async () => {
    const context = createWorkspaceContext(developmentWorkspace.id);

    await expect(
      withWorkspaceTransaction(database, context, async (repositories) => {
        await repositories.settings.createVersion({
          changedBy: { service: "integration-test", type: "SERVICE" },
          changeReason: "Verify rollback",
          effectiveAt: new Date("2026-07-28T00:00:00.000Z"),
          key: "test.rollback",
          value: { enabled: true },
          valueType: "JSON",
          version: 1,
        });
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const repositories = createWorkspaceRepositories(database, context);
    await expect(repositories.settings.findLatest("test.rollback")).resolves.toBeNull();
  });

  it("enforces valid audit actor shapes and workspace actor ownership", async () => {
    await expect(
      database.auditEvent.create({
        data: {
          id: "01900000-0000-7000-8000-000000000099",
          action: "invalid.actor",
          actorType: "USER",
          correlationId: "01900000-0000-7000-8000-000000000098",
          resourceType: "test",
          workspaceId: developmentWorkspace.id,
        },
      }),
    ).rejects.toBeDefined();
  });
});

describe("authentication and workspace authorisation", () => {
  const correlationId = "01900000-0000-7000-8000-000000000120";

  it("binds an approved active identity to the single seeded workspace and audits sign-in", async () => {
    const repositories = createWorkspaceRepositories(
      database,
      createWorkspaceContext(developmentWorkspace.id),
    );
    const allowlisted = await repositories.users.create({
      email: "approved@studio.example",
    });

    await expect(
      authoriseOidcIdentity(
        database,
        {
          displayName: "Approved Teammate",
          email: "approved@studio.example",
          subject: "google-subject-approved",
        },
        correlationId,
        new Date("2026-07-28T01:20:00.000Z"),
      ),
    ).resolves.toEqual({
      allowed: true,
      principal: {
        internalUserId: allowlisted.id,
        sessionVersion: 1,
        workspaceId: developmentWorkspace.id,
      },
    });
    await expect(repositories.users.findById(allowlisted.id)).resolves.toMatchObject({
      displayName: "Approved Teammate",
      lastLoginAt: new Date("2026-07-28T01:20:00.000Z"),
      oidcSubject: "google-subject-approved",
    });
    await expect(database.auditEvent.findMany()).resolves.toEqual([
      expect.objectContaining({
        action: "auth.sign_in.succeeded",
        actorUserId: allowlisted.id,
        correlationId,
        resourceId: allowlisted.id,
        workspaceId: developmentWorkspace.id,
      }),
    ]);
  });

  it("denies unlisted, inactive and subject-mismatched identities without returning data", async () => {
    const repositories = createWorkspaceRepositories(
      database,
      createWorkspaceContext(developmentWorkspace.id),
    );

    await expect(
      authoriseOidcIdentity(
        database,
        { email: "unlisted@studio.example", subject: "unlisted-subject" },
        correlationId,
      ),
    ).resolves.toEqual({ allowed: false, reason: "UNLISTED_IDENTITY" });

    const inactive = await repositories.users.create({
      email: "inactive@studio.example",
      oidcSubject: "inactive-subject",
    });
    await repositories.users.setStatus(inactive.id, "DISABLED");
    await expect(
      authoriseOidcIdentity(
        database,
        { email: "inactive@studio.example", subject: "inactive-subject" },
        correlationId,
      ),
    ).resolves.toEqual({ allowed: false, reason: "INACTIVE_USER" });

    const inactiveWorkspace = await database.workspace.create({
      data: {
        id: "01900000-0000-7000-8000-000000000026",
        name: "Inactive Authentication Workspace",
        slug: "inactive-authentication",
        status: "DISABLED",
      },
    });
    await database.internalUser.create({
      data: {
        email: "inactive-workspace@studio.example",
        id: "01900000-0000-7000-8000-000000000027",
        oidcSubject: "inactive-workspace-subject",
        workspaceId: inactiveWorkspace.id,
      },
    });
    await expect(
      authoriseOidcIdentity(
        database,
        {
          email: "inactive-workspace@studio.example",
          subject: "inactive-workspace-subject",
        },
        correlationId,
      ),
    ).resolves.toEqual({ allowed: false, reason: "INACTIVE_WORKSPACE" });

    const bound = await repositories.users.create({
      email: "bound@studio.example",
      oidcSubject: "original-subject",
    });
    await expect(
      authoriseOidcIdentity(
        database,
        { email: "bound@studio.example", subject: "replacement-subject" },
        correlationId,
      ),
    ).resolves.toEqual({ allowed: false, reason: "SUBJECT_MISMATCH" });
    await expect(repositories.users.findById(bound.id)).resolves.toMatchObject({
      oidcSubject: "original-subject",
      lastLoginAt: null,
    });
  });

  it("invalidates existing sessions on deactivation and does not revive them on reactivation", async () => {
    const repositories = createWorkspaceRepositories(
      database,
      createWorkspaceContext(developmentWorkspace.id),
    );
    const actor = await repositories.users.create({
      email: "admin@studio.example",
      oidcSubject: "admin-subject",
    });
    const target = await repositories.users.create({
      email: "target@studio.example",
      oidcSubject: "target-subject",
    });
    const originalPrincipal = {
      internalUserId: target.id,
      sessionVersion: target.sessionVersion,
      workspaceId: developmentWorkspace.id,
    } as const;

    await expect(findActiveSessionPrincipal(database, originalPrincipal)).resolves.toEqual(
      originalPrincipal,
    );
    const disabled = await setInternalUserStatus(database, {
      actorUserId: actor.id,
      correlationId,
      status: "DISABLED",
      targetUserId: target.id,
      workspaceId: developmentWorkspace.id,
    });
    expect(disabled?.sessionVersion).toBe(2);
    await expect(findActiveSessionPrincipal(database, originalPrincipal)).resolves.toBeNull();

    const reactivated = await setInternalUserStatus(database, {
      actorUserId: actor.id,
      correlationId,
      status: "ACTIVE",
      targetUserId: target.id,
      workspaceId: developmentWorkspace.id,
    });
    expect(reactivated?.sessionVersion).toBe(3);
    await expect(findActiveSessionPrincipal(database, originalPrincipal)).resolves.toBeNull();
    await expect(findActiveSessionPrincipal(database, reactivated!)).resolves.toEqual(reactivated);
  });

  it("returns the same safe not-found result for malformed, missing and cross-workspace IDs", async () => {
    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01900000-0000-7000-8000-000000000022",
        name: "Authorisation Isolation Workspace",
        slug: "authorisation-isolation",
      },
    });
    const principal = {
      internalUserId: "01900000-0000-7000-8000-000000000023",
      sessionVersion: 1,
      workspaceId: developmentWorkspace.id,
    } as const;
    const crossWorkspaceUser = await database.internalUser.create({
      data: {
        email: "cross-workspace@studio.example",
        id: "01900000-0000-7000-8000-000000000025",
        workspaceId: secondWorkspace.id,
      },
    });
    const loadInternalUser = ({ id, workspaceId }: { id: string; workspaceId: string }) =>
      database.internalUser.findFirst({ where: { id, workspaceId } });

    const failures = [
      () => requireWorkspaceResource(principal, "not-a-uuid", loadInternalUser),
      () =>
        requireWorkspaceResource(
          principal,
          "01900000-0000-7000-8000-000000000024",
          loadInternalUser,
        ),
      () => requireWorkspaceResource(principal, crossWorkspaceUser.id, loadInternalUser),
    ];

    for (const failure of failures) {
      await expect(failure()).rejects.toEqual(
        expect.objectContaining({
          code: "RESOURCE_NOT_FOUND",
          message: "Resource not found",
          name: WorkspaceResourceNotFoundError.name,
        }),
      );
    }
  });
});
