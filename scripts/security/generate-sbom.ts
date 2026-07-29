import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const sbomOutputPath = "artifacts/sbom/cyclonedx.json";

export type SbomComponent = Readonly<{
  name?: string;
  version?: string;
  purl?: string;
  externalReferences?: readonly Readonly<{ url?: string }>[];
}>;

export type SbomDocument = Readonly<{
  bomFormat?: string;
  specVersion?: string;
  components?: readonly SbomComponent[];
}>;

const credentialInUrlPattern = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/iu;

/**
 * A software bill of materials is published alongside a release, so it must
 * describe the dependency graph and nothing else. Registry URLs that carry
 * embedded credentials would leak a token into a public artifact.
 */
export function assertSbomIsPublishable(document: SbomDocument): void {
  if (document.bomFormat !== "CycloneDX") {
    throw new Error(`Expected a CycloneDX document, received bomFormat "${document.bomFormat}".`);
  }

  if (typeof document.specVersion !== "string" || document.specVersion === "") {
    throw new Error("CycloneDX document is missing specVersion.");
  }

  const components = document.components ?? [];

  if (components.length === 0) {
    throw new Error("CycloneDX document lists no components.");
  }

  for (const component of components) {
    for (const reference of component.externalReferences ?? []) {
      if (typeof reference.url === "string" && credentialInUrlPattern.test(reference.url)) {
        throw new Error(
          `Component ${component.name ?? "(unnamed)"} has an external reference URL containing embedded credentials.`,
        );
      }
    }
  }
}

/**
 * Resolves the npm CLI entry script so it can be run through the current Node
 * binary. Node refuses to spawn `npm.cmd` directly on Windows, and running the
 * JavaScript entry point avoids needing a shell at all.
 */
export function resolveNpmCliPath(
  environment: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): string {
  const fromEnvironment = environment["npm_execpath"];

  if (fromEnvironment !== undefined && fromEnvironment.endsWith(".js")) {
    return fromEnvironment;
  }

  const nodeDirectory = dirname(execPath);

  for (const candidate of [
    resolve(nodeDirectory, "node_modules/npm/bin/npm-cli.js"),
    resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
  ]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not locate the npm CLI entry script to generate an SBOM.");
}

export function generateSbom(repositoryRoot = process.cwd()): SbomDocument {
  const stdout = execFileSync(
    process.execPath,
    [resolveNpmCliPath(), "sbom", "--sbom-format", "cyclonedx", "--omit", "dev"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  return JSON.parse(stdout) as SbomDocument;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  const document = generateSbom();

  assertSbomIsPublishable(document);

  const outputPath = resolve(process.cwd(), sbomOutputPath);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  console.log(
    `Wrote CycloneDX ${document.specVersion} SBOM with ${document.components?.length ?? 0} production components to ${sbomOutputPath}.`,
  );
}
