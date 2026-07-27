import { describe, expect, it } from "vitest";

import { findSecretFindings } from "./check-secrets.js";

describe("findSecretFindings", () => {
  it("reports high-confidence credentials without retaining the matched value", () => {
    const token = ["gh", "p_", "A".repeat(40)].join("");
    const findings = findSecretFindings("synthetic.txt", token);

    expect(findings).toEqual([{ file: "synthetic.txt", rule: "GitHub token" }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });

  it("allows documented placeholders and test configuration", () => {
    expect(
      findSecretFindings(
        ".env.example",
        "DATABASE_URL=postgresql://studio_parallel_test:studio_parallel_test@localhost/test\nAPI_KEY=replace-me",
      ),
    ).toEqual([]);
  });
});
