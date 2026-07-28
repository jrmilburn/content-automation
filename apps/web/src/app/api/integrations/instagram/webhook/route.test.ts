import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "./route";

const callbackUrl = "https://studio-parallel.example/api/integrations/instagram/webhook";
const verifyToken = "test-only-webhook-verifier-not-a-live-credential";

function verificationRequest(parameters: Readonly<Record<string, string>>): Request {
  const url = new URL(callbackUrl);

  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }

  return new Request(url);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Meta webhook verification", () => {
  it("returns the exact numeric challenge for a matching subscription token", async () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", verifyToken);
    const response = GET(
      verificationRequest({
        "hub.challenge": "1158201444",
        "hub.mode": "subscribe",
        "hub.verify_token": verifyToken,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    await expect(response.text()).resolves.toBe("1158201444");
  });

  it.each([
    [
      "wrong token",
      {
        "hub.challenge": "1158201444",
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token-canary",
      },
    ],
    [
      "wrong mode",
      { "hub.challenge": "1158201444", "hub.mode": "unsubscribe", "hub.verify_token": verifyToken },
    ],
    ["missing challenge", { "hub.mode": "subscribe", "hub.verify_token": verifyToken }],
    [
      "non-numeric challenge",
      {
        "hub.challenge": "reflect-me-canary",
        "hub.mode": "subscribe",
        "hub.verify_token": verifyToken,
      },
    ],
  ])("rejects a %s without reflecting request values", async (_name, parameters) => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", verifyToken);
    const response = GET(verificationRequest(parameters));
    const serializedResponse = `${JSON.stringify([...response.headers])}\n${await response.text()}`;

    expect(response.status).toBe(403);
    for (const value of Object.values(parameters)) {
      expect(serializedResponse).not.toContain(value);
    }
  });

  it("fails closed when the deployment token is unavailable", async () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "");
    const response = GET(
      verificationRequest({
        "hub.challenge": "1158201444",
        "hub.mode": "subscribe",
        "hub.verify_token": "provider-token-canary",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("");
  });

  it("does not silently accept unsigned event delivery", async () => {
    const response = POST();

    expect(response.status).toBe(501);
    expect(response.headers.get("cache-control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("");
  });
});
