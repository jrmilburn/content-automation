import { describe, expect, it } from "vitest";

import * as publisherSurface from "./index.js";

describe("queue package process boundary", () => {
  it("keeps handler execution out of the publisher entry point", () => {
    expect(publisherSurface).not.toHaveProperty("createQueueWorkerRuntime");
    expect(publisherSurface).not.toHaveProperty("createPgBossWorkerQueue");
    expect(publisherSurface).not.toHaveProperty("createQueueHandlerRegistry");
  });
});
