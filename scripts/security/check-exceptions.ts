import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const exceptionRegisterPath = "security/exceptions.json";

/**
 * Categories a caller may query. The register declares its own `categories`
 * list, which is what validation checks entries against, so this union only
 * needs to describe the lookups the security checks perform.
 */
export type ExceptionCategory =
  | "dependency-licence"
  | "dependency-prerelease"
  | "dependency-vulnerability"
  | "image-vulnerability"
  | "workflow-policy";

export type SupplyChainException = Readonly<{
  id: string;
  category: string;
  subject: string;
  reason: string;
  owner: string;
  evidence: string;
  approvedOn: string;
  expiresOn: string;
  reviewAction: string;
}>;

export type ExceptionRegister = Readonly<{
  maximumExceptionDays: number;
  categories: readonly string[];
  exceptions: readonly SupplyChainException[];
}>;

const requiredFields = [
  "id",
  "category",
  "subject",
  "reason",
  "owner",
  "evidence",
  "approvedOn",
  "expiresOn",
  "reviewAction",
] as const;

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const millisecondsPerDay = 86_400_000;

export function parseIsoDate(value: string): number | undefined {
  if (!isoDatePattern.test(value)) {
    return undefined;
  }

  const parsed = Date.parse(`${value}T00:00:00Z`);

  return Number.isNaN(parsed) ? undefined : parsed;
}

export function readExceptionRegister(repositoryRoot = process.cwd()): ExceptionRegister {
  const contents = readFileSync(resolve(repositoryRoot, exceptionRegisterPath), "utf8");

  return JSON.parse(contents) as ExceptionRegister;
}

/**
 * Validates the accepted-risk register. Every exception must name an owner, an
 * expiry and evidence, and an expired exception is a hard failure so accepted
 * risk cannot quietly become permanent.
 */
export function checkExceptionRegister(register: ExceptionRegister, now: number): string[] {
  const failures: string[] = [];
  const seenIds = new Set<string>();

  if (!Number.isInteger(register.maximumExceptionDays) || register.maximumExceptionDays <= 0) {
    failures.push("maximumExceptionDays must be a positive whole number of days.");
  }

  for (const exception of register.exceptions) {
    const label = exception.id || "(missing id)";

    for (const field of requiredFields) {
      if (typeof exception[field] !== "string" || exception[field].trim() === "") {
        failures.push(`${label}: ${field} must be a non-empty string.`);
      }
    }

    if (seenIds.has(exception.id)) {
      failures.push(`${label}: duplicate exception id.`);
    }
    seenIds.add(exception.id);

    if (!register.categories.includes(exception.category)) {
      failures.push(`${label}: category "${exception.category}" is not a declared category.`);
    }

    const approvedOn = parseIsoDate(exception.approvedOn ?? "");
    const expiresOn = parseIsoDate(exception.expiresOn ?? "");

    if (approvedOn === undefined) {
      failures.push(`${label}: approvedOn must be an ISO YYYY-MM-DD date.`);
    }

    if (expiresOn === undefined) {
      failures.push(`${label}: expiresOn must be an ISO YYYY-MM-DD date.`);
    }

    if (approvedOn === undefined || expiresOn === undefined) {
      continue;
    }

    if (expiresOn <= approvedOn) {
      failures.push(`${label}: expiresOn must be after approvedOn.`);
      continue;
    }

    const grantedDays = Math.round((expiresOn - approvedOn) / millisecondsPerDay);

    if (grantedDays > register.maximumExceptionDays) {
      failures.push(
        `${label}: granted for ${grantedDays} days, which exceeds the ${register.maximumExceptionDays}-day maximum.`,
      );
    }

    if (expiresOn < now) {
      failures.push(
        `${label}: expired on ${exception.expiresOn}. Remediate the risk or record a fresh approval. Owner: ${exception.owner}.`,
      );
    }
  }

  return failures;
}

export function selectActiveExceptions(
  register: ExceptionRegister,
  category: ExceptionCategory,
  now: number,
): readonly SupplyChainException[] {
  return register.exceptions.filter((exception) => {
    if (exception.category !== category) {
      return false;
    }

    const expiresOn = parseIsoDate(exception.expiresOn ?? "");

    return expiresOn !== undefined && expiresOn >= now;
  });
}

export function hasActiveException(
  register: ExceptionRegister,
  category: ExceptionCategory,
  subject: string,
  now: number,
): boolean {
  return selectActiveExceptions(register, category, now).some(
    (exception) => exception.subject === subject,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const register = readExceptionRegister();
  const failures = checkExceptionRegister(register, Date.now());

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }

    console.error(`Accepted-risk register check failed. See ${exceptionRegisterPath}.`);
    process.exitCode = 1;
  } else {
    console.log(
      `Accepted-risk register passed: ${register.exceptions.length} exception(s), all owned, evidenced and unexpired.`,
    );
  }
}
