import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const accountId = "019a0000-0000-7000-8000-000000000301";
const providerAccountId = "17841400000000000";
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";
const tokenCanary = "IGQVJnotarealtokencanary";

const auditRecord = vi.fn();
const countRecentByActor = vi.fn();
const findActive = vi.fn();
const findActiveAdminPrincipal = vi.fn();
const findFirst = vi.fn();
const commitInstagramDisconnect = vi.fn();
const decryptCredential = vi.fn();
const revokeInstagramAccess = vi.fn();

vi.mock("@studio-parallel/config", () => ({
  loadCredentialEncryptionConfig: () => ({
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CREDENTIAL_ENCRYPTION_KEY_VERSION: 1,
  }),
}));

vi.mock("@studio-parallel/db", () => ({
  commitInstagramDisconnect: (...args: unknown[]) => commitInstagramDisconnect(...args),
  createWorkspaceContext: (workspaceId: string) => ({ workspaceId }),
  createWorkspaceRepositories: () => ({
    audit: {
      countRecentByActor: (...args: unknown[]) => countRecentByActor(...args),
      record: (...args: unknown[]) => auditRecord(...args),
    },
    credentials: { findActive: (...args: unknown[]) => findActive(...args) },
  }),
  decodeMasterKey: (value: string) => Buffer.from(value, "base64"),
  decryptCredential: (...args: unknown[]) => decryptCredential(...args),
  findActiveAdminPrincipal: (...args: unknown[]) => findActiveAdminPrincipal(...args),
  instagramAccountResourceType: "instagram_account",
  instagramDisconnectedAction: "instagram.connection.disconnected",
  isUuidV7: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
}));

vi.mock("./database", () => ({
  getDatabase: () => ({
    instagramAccount: { findFirst: (...args: unknown[]) => findFirst(...args) },
  }),
}));

vi.mock("./instagram-oauth-client", () => ({
  revokeInstagramAccess: (...args: unknown[]) => revokeInstagramAccess(...args),
}));

const { disconnectInstagramAccount, disconnectAttemptLimit } =
  await import("./instagram-disconnection");

function disconnect(overrides: Partial<Parameters<typeof disconnectInstagramAccount>[0]> = {}) {
  return disconnectInstagramAccount({ accountId, actor, correlationId, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  findActiveAdminPrincipal.mockResolvedValue(actor);
  countRecentByActor.mockResolvedValue(0);
  findFirst.mockResolvedValue({ id: accountId, providerAccountId });
  findActive.mockResolvedValue({ ciphertext: "sealed.envelope", keyVersion: 1 });
  decryptCredential.mockReturnValue(tokenCanary);
  revokeInstagramAccess.mockResolvedValue(true);
  commitInstagramDisconnect.mockResolvedValue({ changed: true, revocation: "SUCCEEDED" });
});

describe("disconnectInstagramAccount authorisation", () => {
  it("refuses a non-admin and never reads a credential", async () => {
    findActiveAdminPrincipal.mockResolvedValue(null);

    await expect(disconnect()).resolves.toEqual({
      disconnected: false,
      reason: "ADMIN_REQUIRED",
    });

    expect(findActive).not.toHaveBeenCalled();
    expect(commitInstagramDisconnect).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "REFUSED", reasonCode: "ADMIN_REQUIRED" }),
    );
  });

  it("re-reads the role from the database rather than trusting the session", async () => {
    await disconnect();
    expect(findActiveAdminPrincipal).toHaveBeenCalledWith(expect.anything(), actor);
  });

  it.each([
    ["a crafted non-uuid", "not-a-uuid"],
    ["a uuid of the wrong version", "0192f2a0-0000-4000-8000-000000000001"],
  ])("refuses %s without querying for it", async (_label, craftedId) => {
    await expect(disconnect({ accountId: craftedId })).resolves.toEqual({
      disconnected: false,
      reason: "ACCOUNT_NOT_FOUND",
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(commitInstagramDisconnect).not.toHaveBeenCalled();
  });

  it("refuses a well-formed identifier belonging to another workspace", async () => {
    // The lookup is workspace-scoped, so a foreign account simply reads nothing.
    findFirst.mockResolvedValue(null);

    await expect(disconnect()).resolves.toEqual({
      disconnected: false,
      reason: "ACCOUNT_NOT_FOUND",
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: accountId, workspaceId: actor.workspaceId },
      }),
    );
  });

  it("does not echo a crafted identifier into the audit trail as a resource", async () => {
    findFirst.mockResolvedValue(null);
    await disconnect();

    expect(auditRecord).toHaveBeenCalledWith(
      expect.not.objectContaining({ resourceId: expect.anything() }),
    );
  });

  it("refuses once the per-actor attempt limit is reached", async () => {
    countRecentByActor.mockResolvedValue(disconnectAttemptLimit);

    await expect(disconnect()).resolves.toEqual({ disconnected: false, reason: "RATE_LIMITED" });
    expect(commitInstagramDisconnect).not.toHaveBeenCalled();
  });
});

describe("disconnectInstagramAccount revocation", () => {
  it("revokes at the provider before purging locally", async () => {
    const order: string[] = [];
    revokeInstagramAccess.mockImplementation(async () => {
      order.push("revoke");
      return true;
    });
    commitInstagramDisconnect.mockImplementation(async () => {
      order.push("purge");
      return { changed: true, revocation: "SUCCEEDED" };
    });

    await disconnect();

    // Purging first would destroy the only token that can authorise a revocation.
    expect(order).toEqual(["revoke", "purge"]);
    expect(revokeInstagramAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: tokenCanary, providerAccountId }),
    );
  });

  it("still purges when the provider refuses the revocation", async () => {
    revokeInstagramAccess.mockResolvedValue(false);
    commitInstagramDisconnect.mockResolvedValue({ changed: true, revocation: "FAILED" });

    await expect(disconnect()).resolves.toEqual({
      changed: true,
      disconnected: true,
      revocation: "FAILED",
    });

    expect(commitInstagramDisconnect).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ revocation: "FAILED" }),
    );
  });

  it("still purges when the credential cannot be decrypted", async () => {
    decryptCredential.mockImplementation(() => {
      throw new Error("AUTHENTICATION_FAILED");
    });

    await disconnect();

    expect(revokeInstagramAccess).not.toHaveBeenCalled();
    expect(commitInstagramDisconnect).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ revocation: "NOT_ATTEMPTED" }),
    );
  });

  it("records no revocation attempt when there is no active credential to revoke", async () => {
    findActive.mockResolvedValue(null);

    await disconnect();

    expect(revokeInstagramAccess).not.toHaveBeenCalled();
    expect(commitInstagramDisconnect).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ revocation: "NOT_ATTEMPTED" }),
    );
  });

  it("binds decryption to the account and workspace that own the row", async () => {
    await disconnect();

    expect(decryptCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        context: {
          accountId,
          integrationType: "INSTAGRAM",
          workspaceId: actor.workspaceId,
        },
      }),
    );
  });
});

describe("disconnectInstagramAccount outcome", () => {
  it("reports an unchanged result when the account was already disconnected", async () => {
    findActive.mockResolvedValue(null);
    commitInstagramDisconnect.mockResolvedValue({ changed: false, revocation: "NOT_ATTEMPTED" });

    await expect(disconnect()).resolves.toEqual({
      changed: false,
      disconnected: true,
      revocation: "NOT_ATTEMPTED",
    });
  });

  it("never returns credential material to its caller", async () => {
    const result = await disconnect();
    expect(JSON.stringify(result)).not.toContain(tokenCanary);
  });
});
