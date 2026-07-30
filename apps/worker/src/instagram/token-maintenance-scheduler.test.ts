import { describe, expect, it } from "vitest";

import { instagramTokenMaintenanceKey } from "./token-maintenance-scheduler.js";

const credentialId = "01900000-0000-7000-8000-0000000000aa";

describe("instagramTokenMaintenanceKey", () => {
  it("is stable across sweeps within the same UTC day", () => {
    const morning = instagramTokenMaintenanceKey(
      credentialId,
      new Date("2026-07-31T00:05:00.000Z"),
    );
    const evening = instagramTokenMaintenanceKey(
      credentialId,
      new Date("2026-07-31T23:55:00.000Z"),
    );

    // A sweep every few minutes must not fill the queue with duplicates.
    expect(morning).toBe(evening);
  });

  it("changes on the next day so maintenance runs again", () => {
    const today = instagramTokenMaintenanceKey(credentialId, new Date("2026-07-31T23:59:59.000Z"));
    const tomorrow = instagramTokenMaintenanceKey(
      credentialId,
      new Date("2026-08-01T00:00:00.000Z"),
    );

    expect(today).not.toBe(tomorrow);
  });

  it("separates credentials", () => {
    const at = new Date("2026-07-31T00:00:00.000Z");
    const other = "01900000-0000-7000-8000-0000000000bb";

    expect(instagramTokenMaintenanceKey(credentialId, at)).not.toBe(
      instagramTokenMaintenanceKey(other, at),
    );
  });

  it("stays within the idempotency key column and character set", () => {
    const key = instagramTokenMaintenanceKey(credentialId, new Date("2026-07-31T00:00:00.000Z"));

    expect(key.length).toBeLessThanOrEqual(255);
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u);
  });
});
