import { describe, expect, it } from "vitest";

import type { ExceptionRegister } from "./check-exceptions.js";
import {
  checkDirectDependencies,
  collectDeclaredDependencies,
  type DeclaredDependency,
  type DependencyRegister,
  type DependencyReview,
  readDependencyRegister,
  readInstalledLicence,
} from "./check-direct-dependencies.js";

const now = Date.parse("2026-07-29T00:00:00Z");

const emptyExceptions: ExceptionRegister = {
  maximumExceptionDays: 180,
  categories: ["dependency-licence", "dependency-prerelease"],
  exceptions: [],
};

function createExceptions(
  category: string,
  subject: string,
  expiresOn = "2027-01-01",
): ExceptionRegister {
  return {
    ...emptyExceptions,
    exceptions: [
      {
        id: `${category}-${subject}`,
        category,
        subject,
        reason: "Recorded accepted risk.",
        owner: "Studio Parallel engineering lead",
        evidence: "https://example.invalid/evidence",
        approvedOn: "2026-07-01",
        expiresOn,
        reviewAction: "Replace or re-approve.",
      },
    ],
  };
}

function createReview(overrides: Partial<DependencyReview> = {}): DependencyReview {
  return {
    name: "example",
    scope: "production",
    licence: "MIT",
    necessity: "Provides a required capability.",
    maintenance: "Actively maintained.",
    reviewedOn: "2026-07-01",
    reviewedBy: "Studio Parallel engineering lead",
    ...overrides,
  };
}

function createRegister(dependencies: readonly DependencyReview[]): DependencyRegister {
  return {
    reviewIntervalDays: 180,
    allowedLicences: {
      production: ["Apache-2.0", "ISC", "MIT"],
      development: ["Apache-2.0", "ISC", "MIT", "MPL-2.0"],
    },
    dependencies,
  };
}

function createDeclared(overrides: Partial<DeclaredDependency> = {}): DeclaredDependency {
  return {
    name: "example",
    version: "1.2.3",
    scope: "production",
    manifests: ["package.json"],
    ...overrides,
  };
}

describe("collectDeclaredDependencies", () => {
  const declared = collectDeclaredDependencies();

  it("finds external dependencies across every workspace manifest", () => {
    const names = declared.map(({ name }) => name);

    expect(names).toContain("next");
    expect(names).toContain("pg-boss");
    expect(names).toContain("vitest");
  });

  it("excludes workspace-internal packages, which carry no third-party risk", () => {
    expect(
      declared.map(({ name }) => name).filter((name) => name.startsWith("@studio-parallel/")),
    ).toEqual([]);
  });

  it("treats a package as production scope when any manifest ships it at runtime", () => {
    expect(declared.find(({ name }) => name === "zod")?.scope).toBe("production");
    expect(declared.find(({ name }) => name === "prettier")?.scope).toBe("development");
  });
});

describe("checkDirectDependencies", () => {
  it("accepts a fully reviewed dependency", () => {
    const result = checkDirectDependencies(
      [createDeclared()],
      createRegister([createReview()]),
      emptyExceptions,
      now,
    );

    expect(result).toEqual({ failures: [], warnings: [] });
  });

  it("rejects an unreviewed direct dependency and names the manifest that declares it", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared({ manifests: ["apps/web/package.json"] })],
      createRegister([]),
      emptyExceptions,
      now,
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("apps/web/package.json");
    expect(failures[0]).toContain("no necessity, maintenance and licence review");
  });

  it("rejects a review left behind after the dependency was removed", () => {
    const { failures } = checkDirectDependencies(
      [],
      createRegister([createReview()]),
      emptyExceptions,
      now,
    );

    expect(failures).toEqual([
      "example: reviewed in security/direct-dependencies.json but no longer a direct dependency. Remove the stale entry.",
    ]);
  });

  it("rejects a version range, because a range is not a reproducible pin", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared({ version: "^1.2.3" })],
      createRegister([createReview()]),
      emptyExceptions,
      now,
    );

    expect(failures).toEqual([
      'example: version "^1.2.3" is not an exact pin. Direct dependencies must be exact.',
    ]);
  });

  it("rejects a licence outside the allowlist for the scope it ships in", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared()],
      createRegister([createReview({ licence: "MPL-2.0" })]),
      emptyExceptions,
      now,
    );

    expect(failures).toEqual([
      "example: licence MPL-2.0 is not allowed for production scope and has no active exception.",
    ]);
  });

  it("allows a copyleft licence in development scope, where nothing is shipped", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared({ scope: "development" })],
      createRegister([createReview({ scope: "development", licence: "MPL-2.0" })]),
      emptyExceptions,
      now,
    );

    expect(failures).toEqual([]);
  });

  it("accepts a disallowed licence only while an unexpired exception covers it", () => {
    const declared = [createDeclared()];
    const register = createRegister([createReview({ licence: "MPL-2.0" })]);

    expect(
      checkDirectDependencies(
        declared,
        register,
        createExceptions("dependency-licence", "example"),
        now,
      ).failures,
    ).toEqual([]);

    expect(
      checkDirectDependencies(
        declared,
        register,
        createExceptions("dependency-licence", "example", "2026-07-01"),
        now,
      ).failures,
    ).toHaveLength(1);
  });

  it("rejects a prerelease production dependency with no active exception", () => {
    const declared = [createDeclared({ version: "5.0.0-beta.32" })];
    const register = createRegister([createReview()]);

    expect(checkDirectDependencies(declared, register, emptyExceptions, now).failures).toEqual([
      "example: prerelease version 5.0.0-beta.32 ships to production and has no active exception.",
    ]);

    expect(
      checkDirectDependencies(
        declared,
        register,
        createExceptions("dependency-prerelease", "example"),
        now,
      ).failures,
    ).toEqual([]);
  });

  it("does not gate development dependencies on prerelease status", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared({ scope: "development", version: "5.0.0-beta.32" })],
      createRegister([createReview({ scope: "development" })]),
      emptyExceptions,
      now,
    );

    expect(failures).toEqual([]);
  });

  it("rejects a reviewed licence that disagrees with the installed package", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared()],
      createRegister([createReview()]),
      emptyExceptions,
      now,
      () => "GPL-3.0",
    );

    expect(failures).toEqual([
      "example: installed licence GPL-3.0 does not match the reviewed licence MIT.",
    ]);
  });

  it("rejects a scope recorded differently from the way the package is declared", () => {
    const { failures } = checkDirectDependencies(
      [createDeclared({ scope: "production" })],
      createRegister([createReview({ scope: "development" })]),
      emptyExceptions,
      now,
    );

    expect(failures).toContain(
      "example: reviewed as development scope but declared as production scope.",
    );
  });

  it("warns rather than fails when a review passes its cadence", () => {
    const result = checkDirectDependencies(
      [createDeclared()],
      createRegister([createReview({ reviewedOn: "2025-01-01" })]),
      emptyExceptions,
      now,
    );

    expect(result.failures).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("past the 180-day cadence");
  });
});

describe("the repository direct dependency register", () => {
  it("covers every declared dependency with a licence that matches the installed package", () => {
    const result = checkDirectDependencies(
      collectDeclaredDependencies(),
      readDependencyRegister(),
      emptyExceptions,
      Date.parse("2026-07-29T00:00:00Z"),
      (name) => readInstalledLicence(name),
    );

    // The one accepted risk in the repository register is a prerelease, not a
    // licence, so an empty exception register must leave exactly that failure.
    expect(result.failures).toEqual([
      "next-auth: prerelease version 5.0.0-beta.32 ships to production and has no active exception.",
    ]);
  });
});
