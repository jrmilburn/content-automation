import { describe, expect, it } from "vitest";

import { assertSbomIsPublishable, resolveNpmCliPath, type SbomDocument } from "./generate-sbom.js";

function createSbom(overrides: Partial<SbomDocument> = {}): SbomDocument {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    components: [{ name: "zod", version: "4.4.3", purl: "pkg:npm/zod@4.4.3" }],
    ...overrides,
  };
}

describe("assertSbomIsPublishable", () => {
  it("accepts a populated CycloneDX document", () => {
    expect(() => assertSbomIsPublishable(createSbom())).not.toThrow();
  });

  it("rejects a document that is not CycloneDX", () => {
    expect(() => assertSbomIsPublishable(createSbom({ bomFormat: "SPDX" }))).toThrow(
      /Expected a CycloneDX document/u,
    );
  });

  it("rejects a document with no specVersion", () => {
    expect(() => assertSbomIsPublishable(createSbom({ specVersion: "" }))).toThrow(
      /missing specVersion/u,
    );
  });

  it("rejects an empty component list, which would publish a meaningless bill of materials", () => {
    expect(() => assertSbomIsPublishable(createSbom({ components: [] }))).toThrow(
      /lists no components/u,
    );
  });

  it("rejects a registry reference carrying embedded credentials", () => {
    const document = createSbom({
      components: [
        {
          name: "private-package",
          externalReferences: [{ url: "https://user:s3cret@registry.invalid/private-package" }],
        },
      ],
    });

    expect(() => assertSbomIsPublishable(document)).toThrow(/embedded credentials/u);
  });

  it("accepts ordinary registry and repository references", () => {
    const document = createSbom({
      components: [
        {
          name: "zod",
          externalReferences: [
            { url: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz" },
            { url: "git+https://github.com/colinhacks/zod.git" },
          ],
        },
      ],
    });

    expect(() => assertSbomIsPublishable(document)).not.toThrow();
  });
});

describe("resolveNpmCliPath", () => {
  it("prefers the npm entry script the current npm run provided", () => {
    expect(resolveNpmCliPath({ npm_execpath: "/opt/npm/bin/npm-cli.js" })).toBe(
      "/opt/npm/bin/npm-cli.js",
    );
  });

  it("ignores a shell wrapper, which Node refuses to spawn directly", () => {
    expect(() => resolveNpmCliPath({ npm_execpath: "C:/npm.cmd" }, "/nonexistent/node")).toThrow(
      /Could not locate the npm CLI/u,
    );
  });

  it("resolves an entry script from the real Node installation", () => {
    expect(resolveNpmCliPath({})).toMatch(/npm-cli\.js$/u);
  });
});
