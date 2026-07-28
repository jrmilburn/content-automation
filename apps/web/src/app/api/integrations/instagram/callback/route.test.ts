import { describe, expect, it } from "vitest";

import { GET } from "./route";

const callbackUrl = "https://studio-parallel.example/api/integrations/instagram/callback";

describe("Instagram redirect verification callback", () => {
  it("returns a stable, non-cacheable readiness response", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({
      integration: "instagram",
      purpose: "redirect_verification",
      status: "ready",
    });
  });

  it("does not reflect or process provider query parameters", async () => {
    const queryValues = ["authorization-code-canary", "state-canary", "provider-error-canary"];
    const request = new Request(
      `${callbackUrl}?code=${queryValues[0]}&state=${queryValues[1]}&error_description=${queryValues[2]}`,
    );

    // Next passes the request at runtime; this cast proves the handler remains
    // constant even when the provider appends credential-shaped query values.
    const routeHandler = GET as (request: Request) => Response;
    const response = routeHandler(request);
    const responseText = await response.text();
    const serializedResponse = `${JSON.stringify([...response.headers])}\n${responseText}`;

    for (const value of queryValues) {
      expect(serializedResponse).not.toContain(value);
    }

    expect(JSON.parse(responseText)).toEqual({
      integration: "instagram",
      purpose: "redirect_verification",
      status: "ready",
    });
  });
});
