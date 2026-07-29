import { describe, expect, it } from "vitest";

import {
  checkWorkflowSource,
  checkWorkflowSources,
  extractTriggers,
  readWorkflowSources,
} from "./check-workflow-policy.js";

const pinnedSha = "3d3c42e5aac5ba805825da76410c181273ba90b1";

function createWorkflow(body: string): { name: string; content: string } {
  return { name: "fixture.yml", content: body };
}

const compliantWorkflow = createWorkflow(`name: Fixture

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${pinnedSha} # v7.0.1
      - run: npm ci
`);

describe("extractTriggers", () => {
  it("reads a block trigger mapping", () => {
    expect(extractTriggers(compliantWorkflow.content)).toEqual(["pull_request", "push"]);
  });

  it("reads an inline trigger list", () => {
    expect(extractTriggers("on: [push, workflow_dispatch]\n")).toEqual([
      "push",
      "workflow_dispatch",
    ]);
  });

  it("does not mistake job keys for triggers", () => {
    expect(extractTriggers(compliantWorkflow.content)).not.toContain("build");
  });
});

describe("checkWorkflowSource", () => {
  it("accepts a commit-pinned, least-privilege workflow", () => {
    expect(checkWorkflowSource(compliantWorkflow)).toEqual([]);
  });

  it("rejects an action pinned to a movable tag", () => {
    const failures = checkWorkflowSource(
      createWorkflow(compliantWorkflow.content.replace(`@${pinnedSha} # v7.0.1`, "@v7")),
    );

    expect(failures).toEqual([
      'fixture.yml:16: "actions/checkout@v7" must be pinned to a full 40-character commit SHA, not a tag or branch.',
    ]);
  });

  it("rejects a commit pin with no recorded release version", () => {
    const failures = checkWorkflowSource(
      createWorkflow(compliantWorkflow.content.replace(" # v7.0.1", "")),
    );

    expect(failures).toEqual([
      'fixture.yml:16: "actions/checkout" is SHA-pinned but has no trailing "# <version>" comment recording which release the pin represents.',
    ]);
  });

  it("rejects a workflow with no declared token permissions", () => {
    const failures = checkWorkflowSource(
      createWorkflow(compliantWorkflow.content.replace("permissions:\n  contents: read\n\n", "")),
    );

    expect(failures).toEqual([
      "fixture.yml: no top-level permissions block. Declare least-privilege GITHUB_TOKEN permissions explicitly.",
    ]);
  });

  it("rejects a pull-request workflow that reads a deployment secret", () => {
    const failures = checkWorkflowSource(
      createWorkflow(
        compliantWorkflow.content.replace(
          "      - run: npm ci\n",
          "      - run: deploy\n        env:\n          KEY: ${{ secrets.PRODUCTION_DEPLOY_KEY }}\n",
        ),
      ),
    );

    expect(failures).toEqual([
      "fixture.yml:19: pull-request-triggered workflow reads secrets.PRODUCTION_DEPLOY_KEY. Untrusted pull-request code must not receive deployment or provider secrets.",
    ]);
  });

  it("allows the scoped job token in a pull-request workflow", () => {
    const failures = checkWorkflowSource(
      createWorkflow(
        compliantWorkflow.content.replace(
          "      - run: npm ci\n",
          "      - run: gh pr view\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
        ),
      ),
    );

    expect(failures).toEqual([]);
  });

  it("rejects pull_request_target unless an exception covers it", () => {
    const workflow = createWorkflow(
      compliantWorkflow.content.replace("  pull_request:\n", "  pull_request_target:\n"),
    );

    expect(checkWorkflowSource(workflow)).toEqual([
      "fixture.yml: pull_request_target runs trusted-context code for untrusted pull requests and is not permitted.",
    ]);
    expect(
      checkWorkflowSource(workflow, (subject) => subject === "fixture.yml:pull_request_target"),
    ).toEqual([]);
  });

  it("rejects a docker action reference", () => {
    const failures = checkWorkflowSource(
      createWorkflow(
        compliantWorkflow.content.replace(
          `actions/checkout@${pinnedSha} # v7.0.1`,
          "docker://alpine:3",
        ),
      ),
    );

    expect(failures).toEqual(["fixture.yml:16: docker:// action references are not permitted."]);
  });

  it("permits a local composite action", () => {
    const failures = checkWorkflowSource(
      createWorkflow(
        compliantWorkflow.content.replace(
          `actions/checkout@${pinnedSha} # v7.0.1`,
          "./.github/actions/setup",
        ),
      ),
    );

    expect(failures).toEqual([]);
  });
});

describe("the repository workflows", () => {
  it("satisfy the supply-chain policy", () => {
    const workflows = readWorkflowSources();

    expect(workflows.length).toBeGreaterThan(0);
    expect(checkWorkflowSources(workflows)).toEqual([]);
  });
});
