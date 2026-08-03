import { describe, expect, it } from "vitest";

import { isApprovedWorkspaceEmail, normaliseMemberEmail } from "./workspace-members.js";

/**
 * The domain check is re-applied at grant time.
 *
 * A command that could add any address would make the approved-domain
 * restriction advisory, and that restriction is the whole authorisation model:
 * an approved domain is necessary but not sufficient, and nothing else stands
 * between an arbitrary Google account and the workspace.
 */

describe("normaliseMemberEmail", () => {
  it("matches how the sign-in path normalises a verified email", () => {
    // A row stored any other way would be one nobody could ever sign in as.
    expect(normaliseMemberEmail("  Person@StudioParallel.AU ")).toBe("person@studioparallel.au");
  });
});

describe("isApprovedWorkspaceEmail", () => {
  it("accepts an address on the approved domain", () => {
    expect(isApprovedWorkspaceEmail("person@studioparallel.au", "studioparallel.au")).toBe(true);
    expect(isApprovedWorkspaceEmail("Person@StudioParallel.AU", "studioparallel.au")).toBe(true);
  });

  it.each([
    ["another domain", "person@example.com"],
    ["a lookalike subdomain", "person@mail.studioparallel.au"],
    ["a suffix that merely ends the same way", "person@notstudioparallel.au"],
    ["two at signs", "person@a@studioparallel.au"],
    ["no local part", "@studioparallel.au"],
    ["no domain", "person@"],
    ["no at sign", "person.studioparallel.au"],
  ])("refuses %s", (_label, email) => {
    expect(isApprovedWorkspaceEmail(email, "studioparallel.au")).toBe(false);
  });

  it("compares the domain case-insensitively from either side", () => {
    expect(isApprovedWorkspaceEmail("person@studioparallel.au", " StudioParallel.AU ")).toBe(true);
  });
});
