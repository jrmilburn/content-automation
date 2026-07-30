import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const authorizeUrl =
  "https://www.instagram.com/oauth/authorize?client_id=1978896389449694&scope=instagram_business_basic%2Cinstagram_business_manage_insights";
const sealedState = "sealed-payload.sealed-signature";

const startInstagramConnection = vi.fn();
const requireAdminActor = vi.fn();

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../../../../../lib/server/instagram-connection", () => ({
  connectionAttemptWindowSeconds: 300,
  startInstagramConnection: (...args: unknown[]) => startInstagramConnection(...args),
}));
vi.mock("../../../../../lib/server/session", () => ({
  requireAdminActor: () => requireAdminActor(),
}));
vi.mock("../../../../../lib/server/observability", () => ({
  webErrorMonitor: { captureException: vi.fn() },
  webLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { POST } = await import("./route");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_ORIGIN", "https://studio-parallel.example");
  requireAdminActor.mockResolvedValue(actor);
  startInstagramConnection.mockResolvedValue({
    authorizeUrl,
    cookieMaxAgeSeconds: 600,
    sealedState,
    started: true,
  });
});

describe("Instagram connection initiation", () => {
  it("redirects to the provider with a host-locked httpOnly state cookie", async () => {
    const response = await POST();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(authorizeUrl);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`__Host-ig_connect_state=${sealedState}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("Path=/");
  });

  it("returns an empty body so nothing about the request is echoed", async () => {
    const response = await POST();

    await expect(response.text()).resolves.toBe("");
  });

  it("refuses a non-admin with 403 and sets no cookie", async () => {
    const { OperationalError } = await import("@studio-parallel/observability");
    requireAdminActor.mockRejectedValue(
      new OperationalError({ code: "ACCESS_DENIED", errorClass: "authorisation", statusCode: 401 }),
    );

    const response = await POST();

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(startInstagramConnection).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After once the attempt limit is reached", async () => {
    startInstagramConnection.mockResolvedValue({ reason: "RATE_LIMITED", started: false });

    const response = await POST();

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("fails closed with 500 and no cookie when initiation throws unexpectedly", async () => {
    startInstagramConnection.mockRejectedValue(new Error("configuration missing"));

    const response = await POST();

    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toBe("");
  });

  it("omits Secure and the host prefix when the origin is not HTTPS", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "http://localhost:3000");

    const cookie = (await POST()).headers.get("set-cookie") ?? "";

    expect(cookie).toContain(`ig_connect_state=${sealedState}`);
    expect(cookie).not.toContain("__Host-");
    expect(cookie).not.toContain("Secure");
  });
});
