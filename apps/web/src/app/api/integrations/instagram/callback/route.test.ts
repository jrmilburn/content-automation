import { beforeEach, describe, expect, it, vi } from "vitest";

const callbackUrl = "https://studio-parallel.example/api/integrations/instagram/callback";

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const completeInstagramConnection = vi.fn();
const requireAdminActor = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../../../lib/server/instagram-connection", () => ({
  completeInstagramConnection: (...args: unknown[]) => completeInstagramConnection(...args),
}));
vi.mock("../../../../../lib/server/session", () => ({
  requireAdminActor: () => requireAdminActor(),
}));
vi.mock("../../../../../lib/server/observability", () => ({
  webErrorMonitor: { captureException: vi.fn() },
  webLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { GET } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_ORIGIN", "https://studio-parallel.example");
  requireAdminActor.mockResolvedValue(actor);
  completeInstagramConnection.mockResolvedValue({ accountId: actor.workspaceId, connected: true });
});

async function serialise(response: Response): Promise<string> {
  return `${JSON.stringify([...response.headers])}\n${await response.text()}`;
}

describe("Instagram connection callback", () => {
  it("redirects to a fixed internal location and clears the state cookie on success", async () => {
    const response = await GET(new Request(`${callbackUrl}?code=abc&state=xyz`));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/integrations?instagram=connected");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("__Host-ig_connect_state");
  });

  it("reports a denied connection without revealing which check failed", async () => {
    completeInstagramConnection.mockResolvedValue({ connected: false, reason: "STATE_MISMATCH" });

    const response = await GET(new Request(`${callbackUrl}?code=abc&state=xyz`));
    const serialised = await serialise(response);

    expect(response.headers.get("location")).toBe("/settings/integrations?instagram=failed");
    // The specific denial reason is audited, never returned.
    expect(serialised).not.toContain("STATE_MISMATCH");
  });

  it("never reflects provider-supplied query values", async () => {
    const canaries = ["authorization-code-canary", "state-canary", "provider-error-canary"];
    completeInstagramConnection.mockResolvedValue({ connected: false, reason: "PROVIDER_ERROR" });

    const response = await GET(
      new Request(
        `${callbackUrl}?code=${canaries[0]}&state=${canaries[1]}&error_description=${canaries[2]}`,
      ),
    );
    const serialised = await serialise(response);

    for (const canary of canaries) {
      expect(serialised).not.toContain(canary);
    }
  });

  it("passes the sealed cookie, code, state and provider error through to the orchestrator", async () => {
    await GET(
      new Request(`${callbackUrl}?code=the-code&state=the-state&error=access_denied`, {
        headers: { cookie: `__Host-ig_connect_state=sealed.value; other=ignored` },
      }),
    );

    expect(completeInstagramConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "the-code",
        providerError: "access_denied",
        receivedState: "the-state",
        sealedState: "sealed.value",
      }),
    );
  });

  it("sends a refused reconnect back naming the account it was started from", async () => {
    completeInstagramConnection.mockResolvedValue({
      connected: false,
      expectedAccountId: "019a0000-0000-7000-8000-000000000301",
      reason: "ACCOUNT_MISMATCH",
    });

    const response = await GET(
      new Request(`${callbackUrl}?code=abc&state=xyz`, {
        headers: { cookie: "__Host-ig_connect_state=sealed.value" },
      }),
    );

    // A distinct outcome, because "it failed" cannot explain that the operator
    // approved a different account than the one they set out to reconnect.
    expect(response.headers.get("location")).toBe(
      "/settings/integrations?instagram=mismatch&account=019a0000-0000-7000-8000-000000000301",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("still reports a refused reconnect when the expected account cannot be named", async () => {
    completeInstagramConnection.mockResolvedValue({
      connected: false,
      reason: "ACCOUNT_MISMATCH",
    });

    const response = await GET(new Request(`${callbackUrl}?code=abc&state=xyz`));

    expect(response.headers.get("location")).toBe("/settings/integrations?instagram=mismatch");
  });

  it("clears the cookie and fails closed when the caller is not an admin", async () => {
    requireAdminActor.mockRejectedValue(new Error("ACCESS_DENIED"));

    const response = await GET(new Request(`${callbackUrl}?code=abc&state=xyz`));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/settings/integrations?instagram=failed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(completeInstagramConnection).not.toHaveBeenCalled();
  });

  it("clears the cookie even when the orchestrator throws", async () => {
    completeInstagramConnection.mockRejectedValue(new Error("unexpected failure"));

    const response = await GET(new Request(`${callbackUrl}?code=abc&state=xyz`));

    expect(response.headers.get("location")).toBe("/settings/integrations?instagram=failed");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("omits Secure and the host prefix when the origin is not HTTPS", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");

    const cookie =
      (await GET(new Request(`${callbackUrl}?code=abc&state=xyz`))).headers.get("set-cookie") ?? "";

    expect(cookie).toContain("ig_connect_state=");
    expect(cookie).not.toContain("__Host-");
    expect(cookie).not.toContain("Secure");
  });
});
