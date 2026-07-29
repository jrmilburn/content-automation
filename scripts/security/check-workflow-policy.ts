import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { hasActiveException, readExceptionRegister } from "./check-exceptions.js";

export const workflowDirectory = ".github/workflows";

const usesPattern = /^\s*(?:-\s+)?uses:\s*(?<reference>\S+)(?<trailer>.*)$/u;
const commitPinPattern = /^(?<action>[^@\s]+)@(?<sha>[0-9a-f]{40})$/u;
const versionCommentPattern = /^\s*#\s*\S+/u;
const untrustedTriggers = new Set(["pull_request", "pull_request_target"]);

/**
 * The scoped job token is the only credential a pull-request workflow may read.
 * Anything else is a deployment or provider secret that untrusted contributor
 * code must never be able to reach.
 */
const allowedSecretReferences = new Set(["GITHUB_TOKEN"]);
const secretReferencePattern = /secrets\.(?<name>[A-Za-z_][A-Za-z0-9_]*)/gu;

export type WorkflowSource = Readonly<{ name: string; content: string }>;

export function readWorkflowSources(repositoryRoot = process.cwd()): WorkflowSource[] {
  const directory = resolve(repositoryRoot, workflowDirectory);

  return readdirSync(directory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      name,
      content: readFileSync(resolve(directory, name), "utf8"),
    }));
}

export function extractTriggers(content: string): string[] {
  const lines = content.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => /^on:/u.test(line));

  if (startIndex < 0) {
    return [];
  }

  const inlineValue = lines[startIndex]?.slice("on:".length).trim() ?? "";

  if (inlineValue !== "") {
    return inlineValue
      .replace(/^\[|\]$/gu, "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const triggers: string[] = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }

    if (!/^\s/u.test(line)) {
      break;
    }

    const match = /^ {2}(?<trigger>[A-Za-z_]+):/u.exec(line);

    if (match?.groups?.trigger) {
      triggers.push(match.groups.trigger);
    }
  }

  return triggers;
}

export function checkWorkflowSource(
  workflow: WorkflowSource,
  isExempt: (subject: string) => boolean = () => false,
): string[] {
  const failures: string[] = [];
  const lines = workflow.content.split(/\r?\n/u);
  const triggers = extractTriggers(workflow.content);

  if (!lines.some((line) => /^permissions:/u.test(line))) {
    failures.push(
      `${workflow.name}: no top-level permissions block. Declare least-privilege GITHUB_TOKEN permissions explicitly.`,
    );
  }

  if (
    triggers.includes("pull_request_target") &&
    !isExempt(`${workflow.name}:pull_request_target`)
  ) {
    failures.push(
      `${workflow.name}: pull_request_target runs trusted-context code for untrusted pull requests and is not permitted.`,
    );
  }

  if (triggers.some((trigger) => untrustedTriggers.has(trigger))) {
    for (const [index, line] of lines.entries()) {
      secretReferencePattern.lastIndex = 0;

      for (const match of line.matchAll(secretReferencePattern)) {
        const name = match.groups?.name ?? "";

        if (!allowedSecretReferences.has(name)) {
          failures.push(
            `${workflow.name}:${index + 1}: pull-request-triggered workflow reads secrets.${name}. Untrusted pull-request code must not receive deployment or provider secrets.`,
          );
        }
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    const match = usesPattern.exec(line);
    const reference = match?.groups?.reference;

    if (!reference) {
      continue;
    }

    const location = `${workflow.name}:${index + 1}`;

    if (reference.startsWith("./")) {
      continue;
    }

    if (reference.startsWith("docker://")) {
      failures.push(`${location}: docker:// action references are not permitted.`);
      continue;
    }

    const pin = commitPinPattern.exec(reference);

    if (!pin) {
      failures.push(
        `${location}: "${reference}" must be pinned to a full 40-character commit SHA, not a tag or branch.`,
      );
      continue;
    }

    if (!versionCommentPattern.test(match?.groups?.trailer ?? "")) {
      failures.push(
        `${location}: "${pin.groups?.action}" is SHA-pinned but has no trailing "# <version>" comment recording which release the pin represents.`,
      );
    }
  }

  return failures;
}

export function checkWorkflowSources(
  workflows: readonly WorkflowSource[],
  isExempt: (subject: string) => boolean = () => false,
): string[] {
  return workflows.flatMap((workflow) => checkWorkflowSource(workflow, isExempt));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const exceptions = readExceptionRegister();
  const now = Date.now();
  const workflows = readWorkflowSources();
  const failures = checkWorkflowSources(workflows, (subject) =>
    hasActiveException(exceptions, "workflow-policy", subject, now),
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }

    console.error("Workflow supply-chain policy check failed.");
    process.exitCode = 1;
  } else {
    console.log(
      `Workflow supply-chain policy passed for ${workflows.length} workflow file(s): actions are commit-pinned, permissions are declared and pull-request runs hold no deployment secrets.`,
    );
  }
}
