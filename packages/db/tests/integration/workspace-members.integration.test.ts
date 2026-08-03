import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";
import { grantWorkspaceMember } from "../../src/workspace-members.js";

/**
 * Granting access, against the constraints that actually enforce it.
 *
 * The colleague this exists for was refused nine times with `unlisted_identity`
 * while everything else about their identity was correct. What matters here is
 * that a grant produces a row sign-in will match, and that re-running is safe.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const approvedDomain = "studioparallel.au";

async function clear(): Promise<void> {
  await database.auditEvent.deleteMany({ where: { action: "workspace.member.granted" } });
  await database.internalUser.deleteMany({ where: { email: { contains: "grant-test" } } });
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(clear);

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

function grant(email: string, role?: "ADMIN" | "MEMBER") {
  return grantWorkspaceMember(database, context, {
    approvedDomain,
    correlationId: createId(),
    email,
    ...(role ? { role } : {}),
  });
}

describe("grantWorkspaceMember", () => {
  it("creates a row the sign-in path will match", async () => {
    const result = await grant("Grant-Test-One@StudioParallel.AU");

    expect(result).toMatchObject({ outcome: "granted", role: "MEMBER" });

    // Sign-in lower-cases the verified email before matching, so anything else
    // would be a row nobody could ever sign in as.
    const stored = await database.internalUser.findFirstOrThrow({
      where: { email: "grant-test-one@studioparallel.au" },
    });
    expect(stored).toMatchObject({ role: "MEMBER", status: "ACTIVE" });
    expect(stored.oidcSubject).toBeNull();
  });

  it("defaults to the least privileged role", async () => {
    expect(await grant("grant-test-two@studioparallel.au")).toMatchObject({ role: "MEMBER" });
  });

  it("grants administrator only when asked", async () => {
    expect(await grant("grant-test-three@studioparallel.au", "ADMIN")).toMatchObject({
      role: "ADMIN",
    });
  });

  it("is safe to re-run and changes nothing", async () => {
    // An operator unsure whether a grant landed should be able to run it again.
    const first = await grant("grant-test-four@studioparallel.au", "ADMIN");
    const second = await grant("grant-test-four@studioparallel.au", "MEMBER");

    expect(second).toMatchObject({ outcome: "already_member", role: "ADMIN" });
    expect(second).toHaveProperty(
      "internalUserId",
      (first as { internalUserId: string }).internalUserId,
    );
    expect(
      await database.internalUser.count({ where: { email: "grant-test-four@studioparallel.au" } }),
    ).toBe(1);
  });

  it("refuses an address outside the approved domain and writes nothing", async () => {
    expect(await grant("grant-test-five@example.com")).toMatchObject({
      approvedDomain,
      outcome: "wrong_domain",
    });
    expect(
      await database.internalUser.count({ where: { email: { contains: "grant-test" } } }),
    ).toBe(0);
  });

  it("records the grant without the address", async () => {
    const result = await grant("grant-test-six@studioparallel.au");

    const event = await database.auditEvent.findFirstOrThrow({
      where: { action: "workspace.member.granted" },
    });

    expect(event.resourceId).toBe((result as { internalUserId: string }).internalUserId);
    expect(JSON.stringify(event)).not.toContain("grant-test-six@studioparallel.au");
  });
});
