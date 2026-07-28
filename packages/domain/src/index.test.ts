import { describe, expect, it } from "vitest";

import { createServiceHealth } from "./index.js";

describe("createServiceHealth", () => {
  it("creates a deterministic, content-free health response", () => {
    const health = createServiceHealth("worker", "ready", new Date("2026-07-28T00:00:00.000Z"));

    expect(health).toEqual({
      service: "worker",
      status: "ok",
      kind: "ready",
      checks: { configuration: "ok" },
      timestamp: "2026-07-28T00:00:00.000Z",
    });
    expect(JSON.stringify(health)).not.toMatch(/environment|release|secret|config(?!uration)/iu);
  });
});
