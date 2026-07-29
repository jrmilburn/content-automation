import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  type ExceptionRegister,
  hasActiveException,
  readExceptionRegister,
} from "./check-exceptions.js";

export const dependencyRegisterPath = "security/direct-dependencies.json";

const workspaceScope = "@studio-parallel/";
const exactVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const prereleasePattern = /^\d+\.\d+\.\d+-/u;
const millisecondsPerDay = 86_400_000;

export type DependencyScope = "production" | "development";

export type DependencyReview = Readonly<{
  name: string;
  scope: DependencyScope;
  licence: string;
  necessity: string;
  maintenance: string;
  reviewedOn: string;
  reviewedBy: string;
  notes?: string;
}>;

export type DependencyRegister = Readonly<{
  reviewIntervalDays: number;
  allowedLicences: Readonly<Record<DependencyScope, readonly string[]>>;
  dependencies: readonly DependencyReview[];
}>;

export type DeclaredDependency = Readonly<{
  name: string;
  version: string;
  scope: DependencyScope;
  manifests: readonly string[];
}>;

export type DependencyCheckResult = Readonly<{
  failures: readonly string[];
  warnings: readonly string[];
}>;

type PackageManifest = Readonly<{
  workspaces?: readonly string[];
  dependencies?: Readonly<Record<string, string>>;
  devDependencies?: Readonly<Record<string, string>>;
}>;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Collects every external direct dependency declared anywhere in the workspace.
 * A package declared as a runtime dependency by any manifest is production
 * scope, because that is the scope that reaches a deployed image.
 */
export function collectDeclaredDependencies(repositoryRoot = process.cwd()): DeclaredDependency[] {
  const root = readJson<PackageManifest>(resolve(repositoryRoot, "package.json"));
  const manifestPaths = [
    "package.json",
    ...(root.workspaces ?? []).map((w) => `${w}/package.json`),
  ];
  const collected = new Map<
    string,
    { version: string; production: boolean; manifests: string[] }
  >();

  for (const manifestPath of manifestPaths) {
    const manifest = readJson<PackageManifest>(resolve(repositoryRoot, manifestPath));

    for (const [block, production] of [
      [manifest.dependencies, true],
      [manifest.devDependencies, false],
    ] as const) {
      for (const [name, version] of Object.entries(block ?? {})) {
        if (name.startsWith(workspaceScope)) {
          continue;
        }

        const existing = collected.get(name);

        collected.set(name, {
          version: existing?.version ?? version,
          production: (existing?.production ?? false) || production,
          manifests: [...(existing?.manifests ?? []), manifestPath],
        });
      }
    }
  }

  return [...collected.entries()]
    .map(([name, entry]) => ({
      name,
      version: entry.version,
      scope: entry.production ? ("production" as const) : ("development" as const),
      manifests: entry.manifests,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function readInstalledLicence(
  name: string,
  repositoryRoot = process.cwd(),
): string | undefined {
  const manifestPath = resolve(repositoryRoot, "node_modules", name, "package.json");

  if (!existsSync(manifestPath)) {
    return undefined;
  }

  const { license } = readJson<{ license?: string }>(manifestPath);

  return typeof license === "string" ? license : undefined;
}

export function readDependencyRegister(repositoryRoot = process.cwd()): DependencyRegister {
  return readJson<DependencyRegister>(resolve(repositoryRoot, dependencyRegisterPath));
}

export function checkDirectDependencies(
  declared: readonly DeclaredDependency[],
  register: DependencyRegister,
  exceptions: ExceptionRegister,
  now: number,
  resolveInstalledLicence: (name: string) => string | undefined = () => undefined,
): DependencyCheckResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const reviews = new Map(register.dependencies.map((review) => [review.name, review]));

  for (const review of register.dependencies) {
    if (!declared.some((dependency) => dependency.name === review.name)) {
      failures.push(
        `${review.name}: reviewed in ${dependencyRegisterPath} but no longer a direct dependency. Remove the stale entry.`,
      );
    }
  }

  for (const dependency of declared) {
    const review = reviews.get(dependency.name);

    if (!review) {
      failures.push(
        `${dependency.name}: direct dependency of ${dependency.manifests.join(", ")} with no necessity, maintenance and licence review in ${dependencyRegisterPath}.`,
      );
      continue;
    }

    if (!exactVersionPattern.test(dependency.version)) {
      failures.push(
        `${dependency.name}: version "${dependency.version}" is not an exact pin. Direct dependencies must be exact.`,
      );
    }

    if (review.scope !== dependency.scope) {
      failures.push(
        `${dependency.name}: reviewed as ${review.scope} scope but declared as ${dependency.scope} scope.`,
      );
    }

    for (const field of ["licence", "necessity", "maintenance", "reviewedBy"] as const) {
      if (typeof review[field] !== "string" || review[field].trim() === "") {
        failures.push(`${dependency.name}: review field ${field} must be a non-empty string.`);
      }
    }

    const allowed = register.allowedLicences[review.scope] ?? [];

    if (
      !allowed.includes(review.licence) &&
      !hasActiveException(exceptions, "dependency-licence", dependency.name, now)
    ) {
      failures.push(
        `${dependency.name}: licence ${review.licence} is not allowed for ${review.scope} scope and has no active exception.`,
      );
    }

    const installedLicence = resolveInstalledLicence(dependency.name);

    if (installedLicence !== undefined && installedLicence !== review.licence) {
      failures.push(
        `${dependency.name}: installed licence ${installedLicence} does not match the reviewed licence ${review.licence}.`,
      );
    }

    if (
      dependency.scope === "production" &&
      prereleasePattern.test(dependency.version) &&
      !hasActiveException(exceptions, "dependency-prerelease", dependency.name, now)
    ) {
      failures.push(
        `${dependency.name}: prerelease version ${dependency.version} ships to production and has no active exception.`,
      );
    }

    const reviewedOn = Date.parse(`${review.reviewedOn}T00:00:00Z`);

    if (Number.isNaN(reviewedOn)) {
      failures.push(`${dependency.name}: reviewedOn must be an ISO YYYY-MM-DD date.`);
      continue;
    }

    const ageDays = Math.floor((now - reviewedOn) / millisecondsPerDay);

    if (ageDays > register.reviewIntervalDays) {
      warnings.push(
        `${dependency.name}: reviewed ${ageDays} days ago, past the ${register.reviewIntervalDays}-day cadence. Refresh the entry.`,
      );
    }
  }

  return { failures, warnings };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const declared = collectDeclaredDependencies();
  const register = readDependencyRegister();
  const exceptions = readExceptionRegister();
  const { failures, warnings } = checkDirectDependencies(
    declared,
    register,
    exceptions,
    Date.now(),
    (name) => readInstalledLicence(name),
  );

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }

    console.error(`Direct dependency review failed. See ${dependencyRegisterPath}.`);
    process.exitCode = 1;
  } else {
    console.log(
      `Direct dependency review passed for ${declared.length} external direct dependencies.`,
    );
  }
}
