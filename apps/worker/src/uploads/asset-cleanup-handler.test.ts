import { queueDefinitions } from "@studio-parallel/domain";
import { describe, expect, it } from "vitest";

import { assetCleanupQueue } from "./asset-cleanup-handler.js";

describe("assetCleanupQueue", () => {
  it("matches a declared queue definition", () => {
    expect(queueDefinitions).toContainEqual({
      name: assetCleanupQueue.name,
      version: assetCleanupQueue.version,
    });
  });
});
