import { describe, expect, it } from "vitest";

import { createServiceHealth } from "./index.js";

describe("createServiceHealth", () => {
  it("creates a deterministic, content-free health response", () => {
    expect(createServiceHealth("worker", "test", new Date("2026-07-28T00:00:00.000Z"))).toEqual({
      service: "worker",
      status: "ok",
      environment: "test",
      timestamp: "2026-07-28T00:00:00.000Z",
    });
  });
});
