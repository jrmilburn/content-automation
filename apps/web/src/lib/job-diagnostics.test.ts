import { describe, expect, it } from "vitest";

import { parseOperationsFilters, resolveJobResourceHref } from "./job-diagnostics";

describe("operations filters", () => {
  it("accepts allowlisted values and makes crafted filters match nothing", () => {
    expect(
      parseOperationsFilters({
        attention: "required",
        resource: "019c0000-0000-7000-8000-000000000201",
        state: "FAILED_ATTENTION",
        type: "analysis.run",
      }),
    ).toMatchObject({
      filters: {
        attention: true,
        queueName: "analysis.run",
        resourceId: "019c0000-0000-7000-8000-000000000201",
        state: "FAILED_ATTENTION",
      },
    });
    expect(
      parseOperationsFilters({ resource: "' OR 1=1 --", state: "not-a-state" }).filters,
    ).toMatchObject({ matchesNothing: true });
  });

  it("creates deep links only for known owned resource types and UUIDv7 identifiers", () => {
    const resourceId = "019c0000-0000-7000-8000-000000000201";
    expect(resolveJobResourceHref("instagram_post", resourceId)).toBe(`/posts/${resourceId}`);
    expect(resolveJobResourceHref("provider_payload", resourceId)).toBeNull();
    expect(resolveJobResourceHref("instagram_post", "../foreign")).toBeNull();
  });
});
