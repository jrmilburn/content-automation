import { describe, expect, it } from "vitest";

import {
  checkExceptionRegister,
  type ExceptionRegister,
  hasActiveException,
  readExceptionRegister,
  selectActiveExceptions,
  type SupplyChainException,
} from "./check-exceptions.js";

const now = Date.parse("2026-07-29T00:00:00Z");

function createException(
  overrides: Partial<SupplyChainException> = {},
): Readonly<SupplyChainException> {
  return {
    id: "dependency-licence-example",
    category: "dependency-licence",
    subject: "example",
    reason: "The only maintained implementation of a required capability.",
    owner: "Studio Parallel engineering lead",
    evidence: "https://example.invalid/advisory",
    approvedOn: "2026-07-01",
    expiresOn: "2026-10-01",
    reviewAction: "Replace the dependency or re-approve with fresh evidence.",
    ...overrides,
  };
}

function createRegister(
  exceptions: readonly SupplyChainException[],
  maximumExceptionDays = 180,
): ExceptionRegister {
  return {
    maximumExceptionDays,
    categories: ["dependency-licence", "dependency-prerelease"],
    exceptions,
  };
}

describe("checkExceptionRegister", () => {
  it("accepts an owned, evidenced and unexpired exception", () => {
    expect(checkExceptionRegister(createRegister([createException()]), now)).toEqual([]);
  });

  it("accepts an empty register", () => {
    expect(checkExceptionRegister(createRegister([]), now)).toEqual([]);
  });

  it("rejects an expired exception and names the accountable owner", () => {
    const failures = checkExceptionRegister(
      createRegister([createException({ approvedOn: "2026-01-01", expiresOn: "2026-06-01" })]),
      now,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("expired on 2026-06-01");
    expect(failures[0]).toContain("Studio Parallel engineering lead");
  });

  it("rejects an exception that is missing an owner, evidence or remediation action", () => {
    for (const field of ["owner", "evidence", "reviewAction"] as const) {
      const failures = checkExceptionRegister(
        createRegister([createException({ [field]: "  " })]),
        now,
      );

      expect(failures).toContain(
        `dependency-licence-example: ${field} must be a non-empty string.`,
      );
    }
  });

  it("rejects an exception granted for longer than the maximum window", () => {
    const failures = checkExceptionRegister(
      createRegister([createException({ approvedOn: "2026-07-01", expiresOn: "2027-07-01" })], 180),
      now,
    );

    expect(failures).toEqual([
      "dependency-licence-example: granted for 365 days, which exceeds the 180-day maximum.",
    ]);
  });

  it("rejects an expiry that does not follow approval", () => {
    const failures = checkExceptionRegister(
      createRegister([createException({ approvedOn: "2026-07-01", expiresOn: "2026-07-01" })]),
      now,
    );

    expect(failures).toEqual(["dependency-licence-example: expiresOn must be after approvedOn."]);
  });

  it("rejects a duplicate identifier and an undeclared category", () => {
    const failures = checkExceptionRegister(
      createRegister([createException(), createException({ category: "made-up" })]),
      now,
    );

    expect(failures).toContain("dependency-licence-example: duplicate exception id.");
    expect(failures).toContain(
      'dependency-licence-example: category "made-up" is not a declared category.',
    );
  });

  it("rejects a malformed date rather than silently treating it as unexpired", () => {
    const failures = checkExceptionRegister(
      createRegister([createException({ expiresOn: "01/10/2026" })]),
      now,
    );

    expect(failures).toEqual([
      "dependency-licence-example: expiresOn must be an ISO YYYY-MM-DD date.",
    ]);
  });
});

describe("selectActiveExceptions", () => {
  it("returns only unexpired exceptions in the requested category", () => {
    const register = createRegister([
      createException({ id: "active", subject: "kept" }),
      createException({ id: "expired", subject: "dropped", expiresOn: "2026-06-01" }),
      createException({ id: "other", subject: "elsewhere", category: "dependency-prerelease" }),
    ]);

    expect(
      selectActiveExceptions(register, "dependency-licence", now).map(({ subject }) => subject),
    ).toEqual(["kept"]);
  });

  it("does not treat an expired exception as cover for its subject", () => {
    const register = createRegister([
      createException({ subject: "example", expiresOn: "2026-06-01" }),
    ]);

    expect(hasActiveException(register, "dependency-licence", "example", now)).toBe(false);
  });
});

describe("the repository accepted-risk register", () => {
  it("is valid today", () => {
    expect(checkExceptionRegister(readExceptionRegister(), Date.now())).toEqual([]);
  });
});
