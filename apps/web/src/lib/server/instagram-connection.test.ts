import { beforeEach, describe, expect, it, vi } from "vitest";

import { sealInstagramState } from "@studio-parallel/domain";

/**
 * Connecting an additional account, and the guard that stops a reconnect from
 * quietly becoming one.
 *
 * The domain package is deliberately not mocked: the sealed cookie and the
 * binding decision are the security-relevant parts, so the test exercises the
 * real sealing and the real comparison rather than a restatement of them.
 */

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const authSecret = "test-only-auth-secret-not-for-deployment-000000";
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";
const state = "pending-state-value";

const firstAccountId = "019a0000-0000-7000-8000-000000000301";
const firstProviderAccountId = "17841400000000001";
const secondProviderAccountId = "17841400000000002";

const auditRecord = vi.fn();
const countRecentByActor = vi.fn();
const findById = vi.fn();
const findByProviderAccountId = vi.fn();
const upsertConnected = vi.fn();
const activate = vi.fn();
const enqueueBackgroundJobInTransaction = vi.fn();

vi.mock("@studio-parallel/config", () => ({
  loadAuthConfig: () => ({ AUTH_SECRET: authSecret }),
  loadCredentialEncryptionConfig: () => ({
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    CREDENTIAL_ENCRYPTION_KEY_VERSION: 1,
  }),
  loadInstagramOAuthConfig: () => ({
    INSTAGRAM_APP_ID: "1978896389449694",
    INSTAGRAM_APP_SECRET: "not-a-real-secret",
  }),
  loadRuntimeConfig: () => ({ PUBLIC_ORIGIN: "https://studio-parallel.example" }),
}));

const repositories = {
  audit: {
    countRecentByActor: (...args: unknown[]) => countRecentByActor(...args),
    record: (...args: unknown[]) => auditRecord(...args),
  },
  credentials: { activate: (...args: unknown[]) => activate(...args) },
  instagramAccounts: {
    findById: (...args: unknown[]) => findById(...args),
    findByProviderAccountId: (...args: unknown[]) => findByProviderAccountId(...args),
    upsertConnected: (...args: unknown[]) => upsertConnected(...args),
  },
};

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (workspaceId: string) => ({ workspaceId }),
  createWorkspaceRepositories: () => repositories,
  decodeMasterKey: (value: string) => Buffer.from(value, "base64"),
  encryptCredential: () => ({ ciphertext: "sealed.envelope", keyVersion: 1 }),
  enqueueBackgroundJobInTransaction: (...args: unknown[]) =>
    enqueueBackgroundJobInTransaction(...args),
  hashGrantedScopes: () => "scope-hash",
  isUuidV7: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
  withWorkspaceTransaction: (_database: unknown, _context: unknown, run: (r: unknown) => unknown) =>
    run(repositories),
}));

vi.mock("./database", () => ({
  getDatabase: () => ({ $transaction: (run: (t: unknown) => unknown) => run({}) }),
}));

const exchangeInstagramAuthorizationCode = vi.fn();
const exchangeForLongLivedInstagramToken = vi.fn();
const fetchInstagramIdentity = vi.fn();

vi.mock("./instagram-oauth-client", () => ({
  exchangeForLongLivedInstagramToken: (...args: unknown[]) =>
    exchangeForLongLivedInstagramToken(...args),
  exchangeInstagramAuthorizationCode: (...args: unknown[]) =>
    exchangeInstagramAuthorizationCode(...args),
  fetchInstagramIdentity: (...args: unknown[]) => fetchInstagramIdentity(...args),
  InstagramProviderError: class extends Error {
    readonly errorClass = "provider";
  },
}));

const { completeInstagramConnection, startInstagramConnection } =
  await import("./instagram-connection");

const now = new Date("2026-08-04T00:00:00.000Z");

/** A cookie for an attempt that was, or was not, bound to an account. */
function sealed(expectedProviderAccountId: string | null): string {
  return sealInstagramState({
    expectedProviderAccountId,
    expiresAt: new Date(now.getTime() + 300_000),
    internalUserId: actor.internalUserId,
    secret: authSecret,
    state,
  });
}

function complete(sealedState: string) {
  return completeInstagramConnection({
    actor,
    code: "provider-code",
    correlationId,
    now,
    receivedState: state,
    sealedState,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  countRecentByActor.mockResolvedValue(0);
  auditRecord.mockResolvedValue(undefined);
  findById.mockResolvedValue({
    id: firstAccountId,
    providerAccountId: firstProviderAccountId,
  });
  findByProviderAccountId.mockResolvedValue({
    id: firstAccountId,
    providerAccountId: firstProviderAccountId,
  });
  upsertConnected.mockResolvedValue({ id: firstAccountId });
  activate.mockResolvedValue(undefined);
  enqueueBackgroundJobInTransaction.mockResolvedValue(undefined);
  exchangeInstagramAuthorizationCode.mockResolvedValue({
    accessToken: "short-lived",
    permissions: [
      "instagram_business_basic",
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ],
  });
  exchangeForLongLivedInstagramToken.mockResolvedValue({
    accessToken: "long-lived",
    expiresAt: new Date("2026-10-03T00:00:00.000Z"),
    tokenType: "bearer",
  });
  fetchInstagramIdentity.mockResolvedValue({
    accountType: "BUSINESS",
    mediaCount: 46,
    providerAccountId: firstProviderAccountId,
    username: "studioparallel",
  });
});

describe("starting a connection", () => {
  it("binds the attempt to the account a reconnect names", async () => {
    const result = await startInstagramConnection({
      actor,
      correlationId,
      now,
      reconnectAccountId: firstAccountId,
    });

    expect(result.started).toBe(true);
    expect(findById).toHaveBeenCalledWith(firstAccountId);

    // The provider identifier held against the callback comes from our own row,
    // never from the browser's submission.
    const opened = await openSealed(result);
    expect(opened?.expectedProviderAccountId).toBe(firstProviderAccountId);
  });

  it("leaves the attempt unbound when no account is named", async () => {
    const result = await startInstagramConnection({ actor, correlationId, now });

    expect(result.started).toBe(true);
    expect(findById).not.toHaveBeenCalled();
    expect((await openSealed(result))?.expectedProviderAccountId).toBeNull();
  });

  it("refuses an account this workspace does not have, and audits nothing", async () => {
    findById.mockResolvedValue(null);

    await expect(
      startInstagramConnection({
        actor,
        correlationId,
        now,
        reconnectAccountId: "019a0000-0000-7000-8000-0000000009ff",
      }),
    ).resolves.toEqual({ reason: "ACCOUNT_NOT_FOUND", started: false });

    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("refuses a crafted account identifier without reading the database", async () => {
    await expect(
      startInstagramConnection({
        actor,
        correlationId,
        now,
        reconnectAccountId: "not-a-uuid",
      }),
    ).resolves.toEqual({ reason: "ACCOUNT_NOT_FOUND", started: false });

    expect(findById).not.toHaveBeenCalled();
  });
});

async function openSealed(result: Awaited<ReturnType<typeof startInstagramConnection>>) {
  if (!result.started) return null;
  const { openInstagramState } = await import("@studio-parallel/domain");
  return openInstagramState(result.sealedState, authSecret);
}

describe("completing a reconnect", () => {
  it("refuses a callback that returns a different account, and changes nothing", async () => {
    fetchInstagramIdentity.mockResolvedValue({
      accountType: "BUSINESS",
      mediaCount: 12,
      providerAccountId: secondProviderAccountId,
      username: "someone-else",
    });

    await expect(complete(sealed(firstProviderAccountId))).resolves.toEqual({
      connected: false,
      expectedAccountId: firstAccountId,
      reason: "ACCOUNT_MISMATCH",
    });

    // No account row, no credential, and no bootstrap import for an account
    // nobody asked to connect.
    expect(upsertConnected).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(enqueueBackgroundJobInTransaction).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "ACCOUNT_MISMATCH", resourceId: firstAccountId }),
    );
  });

  it("succeeds when the callback returns the account it was started from", async () => {
    await expect(complete(sealed(firstProviderAccountId))).resolves.toEqual({
      accountId: firstAccountId,
      connected: true,
    });

    expect(upsertConnected).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: firstProviderAccountId }),
    );
    expect(activate).toHaveBeenCalled();
  });

  it("connects an additional account when the attempt was never bound to one", async () => {
    const secondAccountId = "019a0000-0000-7000-8000-000000000302";
    fetchInstagramIdentity.mockResolvedValue({
      accountType: "CREATOR",
      mediaCount: 3,
      providerAccountId: secondProviderAccountId,
      username: "parallelstudio",
    });
    upsertConnected.mockResolvedValue({ id: secondAccountId });

    await expect(complete(sealed(null))).resolves.toEqual({
      accountId: secondAccountId,
      connected: true,
    });

    // The first account's credential is never touched: activation is scoped to
    // the account it belongs to.
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ accountId: secondAccountId }));
    expect(upsertConnected).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: secondProviderAccountId }),
    );
  });

  it("refuses a mismatch before judging the returned account on its own merits", async () => {
    // An ineligible personal account returned to a bound reconnect must be
    // refused as a mismatch, so the message names the account the operator
    // started from rather than describing the one they accidentally chose.
    fetchInstagramIdentity.mockResolvedValue({
      accountType: "PERSONAL",
      mediaCount: 0,
      providerAccountId: secondProviderAccountId,
      username: "personal-account",
    });

    await expect(complete(sealed(firstProviderAccountId))).resolves.toEqual(
      expect.objectContaining({ reason: "ACCOUNT_MISMATCH" }),
    );
  });
});

describe("judging the returned account's type", () => {
  it("connects a creator account, storing the name the column uses", async () => {
    // Instagram reports a creator as MEDIA_CREATOR. Comparing that against the
    // stored names refused every creator account; it has to be translated.
    fetchInstagramIdentity.mockResolvedValue({
      accountType: "MEDIA_CREATOR",
      mediaCount: 12,
      providerAccountId: secondProviderAccountId,
      username: "parallelstudio",
    });

    await expect(complete(sealed(null))).resolves.toEqual(
      expect.objectContaining({ connected: true }),
    );
    expect(upsertConnected).toHaveBeenCalledWith(
      expect.objectContaining({ accountType: "CREATOR" }),
    );
  });

  it("refuses a personal account and reports which type it saw", async () => {
    fetchInstagramIdentity.mockResolvedValue({
      accountType: "PERSONAL",
      mediaCount: 0,
      providerAccountId: secondProviderAccountId,
      username: "personal-account",
    });

    await expect(complete(sealed(null))).resolves.toEqual({
      connected: false,
      providerAccountType: "PERSONAL",
      reason: "ACCOUNT_TYPE_INELIGIBLE",
    });

    // A refused account leaves nothing behind — no row, and above all no
    // credential for an account that was never connected.
    expect(upsertConnected).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(enqueueBackgroundJobInTransaction).not.toHaveBeenCalled();
  });

  it("does not carry arbitrary provider text into what gets logged", async () => {
    fetchInstagramIdentity.mockResolvedValue({
      accountType: '{"error":{"message":"unexpected"}}',
      mediaCount: 0,
      providerAccountId: secondProviderAccountId,
      username: "odd-account",
    });

    await expect(complete(sealed(null))).resolves.toEqual({
      connected: false,
      providerAccountType: "UNRECOGNISED",
      reason: "ACCOUNT_TYPE_INELIGIBLE",
    });
    expect(upsertConnected).not.toHaveBeenCalled();
  });
});
