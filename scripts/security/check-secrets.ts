import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type SecretFinding = Readonly<{
  file: string;
  rule: string;
}>;

const patterns = [
  { rule: "private key", value: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu },
  { rule: "AWS access key", value: /\bAKIA[0-9A-Z]{16}\b/gu },
  { rule: "GitHub token", value: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu },
  { rule: "GitHub fine-grained token", value: /\bgithub_pat_[A-Za-z0-9_]{70,255}\b/gu },
  { rule: "Google API key", value: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
  { rule: "Meta access token", value: /\bEAA[A-Za-z0-9]{60,}\b/gu },
  { rule: "Slack token", value: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
] as const;

export function findSecretFindings(file: string, content: string): SecretFinding[] {
  return patterns.flatMap(({ rule, value }) => {
    value.lastIndex = 0;
    return value.test(content) ? [{ file, rule }] : [];
  });
}

export function scanTrackedFiles(repositoryRoot = process.cwd()): SecretFinding[] {
  const trackedFiles = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);

  return trackedFiles.flatMap((file) => {
    const absolutePath = resolve(repositoryRoot, file);

    if (!existsSync(absolutePath)) {
      return [];
    }

    const buffer = readFileSync(absolutePath);

    if (buffer.includes(0)) {
      return [];
    }

    return findSecretFindings(file, buffer.toString("utf8"));
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const findings = scanTrackedFiles();

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.file}: potential ${finding.rule}`);
    }

    console.error("Secret scan failed. Findings are identified without printing matched values.");
    process.exitCode = 1;
  } else {
    console.log("Secret scan passed for version-controlled text files.");
  }
}
