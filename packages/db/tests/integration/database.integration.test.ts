import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
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
