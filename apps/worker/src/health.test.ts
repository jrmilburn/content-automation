import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createHealthServer } from "./health.js";

const servers = new Set<ReturnType<typeof createHealthServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  servers.clear();
});

describe("worker health server", () => {
  it.each([
    ["/health/live", "live", { process: "ok" }],
    ["/health/ready", "ready", { configuration: "ok" }],
  ] as const)("serves content-free %s status", async (path, kind, checks) => {
    const server = createHealthServer();
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      headers: {
        "x-correlation-id": "019873d5-31e6-7c59-a531-1f2f4cbce146",
      },
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-correlation-id")).toBe("019873d5-31e6-7c59-a531-1f2f4cbce146");
    expect(body).toMatchObject({ service: "worker", status: "ok", kind, checks });
    expect(JSON.stringify(body)).not.toMatch(
      /environment|release|database_url|provider_mode|secret|token|port/iu,
    );
  });
});
