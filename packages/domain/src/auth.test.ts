import { describe, expect, it } from "vitest";

import { evaluateGoogleOidcProfile, isAllowedRequestOrigin, resolveSafeReturnUrl } from "./auth.js";

describe("Google OIDC policy", () => {
  const approved = {
    email: "approved@studio.example",
    email_verified: true,
    hd: "studio.example",
    name: "Approved Teammate",
    sub: "google-subject-01",
  } as const;

  it("normalises a verified hosted-domain identity", () => {
    expect(
      evaluateGoogleOidcProfile(
        { ...approved, email: "Approved@Studio.Example", hd: "Studio.Example" },
        "studio.example",
      ),
    ).toEqual({
      allowed: true,
      identity: {
        displayName: "Approved Teammate",
        email: "approved@studio.example",
        subject: "google-subject-01",
      },
    });
  });

  it.each([
    [{ ...approved, email_verified: false }, "UNVERIFIED_EMAIL"],
    [{ ...approved, hd: "outside.example" }, "WRONG_DOMAIN"],
    [{ ...approved, email: "outsider@outside.example" }, "WRONG_DOMAIN"],
    [{ ...approved, sub: "malformed\nsubject" }, "MALFORMED_CLAIMS"],
    [{ ...approved, email: undefined }, "MALFORMED_CLAIMS"],
  ] as const)(
    "denies malformed or unapproved claims without returning profile data",
    (profile, reason) => {
      const decision = evaluateGoogleOidcProfile(profile, "studio.example");

      expect(decision).toEqual({ allowed: false, reason });
      expect(JSON.stringify(decision)).not.toContain("approved@studio.example");
    },
  );
});

describe("authentication URL and origin policy", () => {
  const origin = "https://content.studio.example";

  it.each([
    ["/dashboard?from=session", "https://content.studio.example/dashboard?from=session"],
    ["https://content.studio.example/posts", "https://content.studio.example/posts"],
    ["https://outside.example/steal", origin],
    ["//outside.example/steal", origin],
    ["/\\outside.example/steal", origin],
    ["not a url%", "https://content.studio.example/not%20a%20url%"],
  ])("resolves return URL %s without permitting an off-site redirect", (candidate, expected) => {
    expect(resolveSafeReturnUrl(candidate, origin)).toBe(expected);
  });

  it("requires an exact same-origin POST source", () => {
    expect(isAllowedRequestOrigin(origin, origin)).toBe(true);
    expect(isAllowedRequestOrigin("https://outside.example", origin)).toBe(false);
    expect(isAllowedRequestOrigin(null, origin)).toBe(false);
  });
});
