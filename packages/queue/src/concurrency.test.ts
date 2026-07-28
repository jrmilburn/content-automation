import { describe, expect, it } from "vitest";

import { createProviderConcurrencyGate } from "./concurrency.js";

describe("provider concurrency gate", () => {
  it("enforces global and provider limits without blocking a different provider", async () => {
    const gate = createProviderConcurrencyGate({
      globalLimit: 2,
      providerLimits: { gemini: 2, meta: 1 },
    });
    const releaseMeta1 = await gate.acquire("meta");
    let meta2Acquired = false;
    const meta2 = gate.acquire("meta").then((release) => {
      meta2Acquired = true;
      return release;
    });
    const releaseGemini = await gate.acquire("gemini");

    await Promise.resolve();
    expect(meta2Acquired).toBe(false);
    releaseMeta1();
    const releaseMeta2 = await meta2;
    expect(meta2Acquired).toBe(true);

    releaseMeta2();
    releaseGemini();
  });

  it("removes an aborted waiter without consuming a permit", async () => {
    const gate = createProviderConcurrencyGate({
      globalLimit: 1,
      providerLimits: { gemini: 1 },
    });
    const release = await gate.acquire("gemini");
    const controller = new AbortController();
    const waiting = gate.acquire("gemini", controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: "JOB_CONCURRENCY_ABORTED" });
    release();
    await expect(gate.acquire("gemini")).resolves.toEqual(expect.any(Function));
  });
});
