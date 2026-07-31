import { describe, expect, it } from "vitest";

import { createSourceVideoObjectKey, isSourceVideoObjectKeyFor } from "./object-key.js";

const parts = {
  environment: "production",
  workspaceId: "019a0000-0000-7000-8000-000000000001",
} as const;

describe("createSourceVideoObjectKey", () => {
  it("prefixes by environment and workspace so environments never share objects", () => {
    const key = createSourceVideoObjectKey(parts);

    expect(key.startsWith("production/019a0000-0000-7000-8000-000000000001/source-video/")).toBe(
      true,
    );
  });

  it("never repeats a key across calls", () => {
    const keys = new Set(Array.from({ length: 500 }, () => createSourceVideoObjectKey(parts)));

    expect(keys.size).toBe(500);
  });

  it("does not encode a filename or a sortable timestamp in the suffix", () => {
    const suffix = createSourceVideoObjectKey(parts).split("/").at(3);

    expect(suffix).toMatch(/^[0-9a-f]{32}$/u);

    // A UUIDv7-style key would sort by creation time and leak ordering. Random
    // suffixes generated in sequence must not come back already sorted.
    const sequential = Array.from({ length: 24 }, () =>
      createSourceVideoObjectKey(parts).split("/").at(3),
    );

    expect(sequential).not.toEqual([...sequential].sort());
  });
});

describe("isSourceVideoObjectKeyFor", () => {
  it("accepts a key it generated for the same environment and workspace", () => {
    expect(isSourceVideoObjectKeyFor(createSourceVideoObjectKey(parts), parts)).toBe(true);
  });

  it("rejects a key belonging to another workspace or environment", () => {
    const key = createSourceVideoObjectKey(parts);

    expect(
      isSourceVideoObjectKeyFor(key, {
        environment: "production",
        workspaceId: "019a0000-0000-7000-8000-000000000002",
      }),
    ).toBe(false);
    expect(isSourceVideoObjectKeyFor(key, { ...parts, environment: "staging" })).toBe(false);
  });

  it("rejects traversal, prefix-extension and malformed suffixes", () => {
    for (const crafted of [
      "production/019a0000-0000-7000-8000-000000000001/source-video/../../etc/passwd",
      "production/019a0000-0000-7000-8000-000000000001/source-video/not-hex-suffix",
      "production/019a0000-0000-7000-8000-000000000001/source-video/0123456789abcdef",
      "production/019a0000-0000-7000-8000-000000000001/other/0123456789abcdef0123456789abcdef",
      "production/019a0000-0000-7000-8000-000000000001/source-video/0123456789abcdef0123456789abcdef/extra",
      "",
    ]) {
      expect(isSourceVideoObjectKeyFor(crafted, parts)).toBe(false);
    }
  });
});
