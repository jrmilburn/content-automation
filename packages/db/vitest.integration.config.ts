import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: [
      "packages/db/tests/integration/**/*.integration.test.ts",
      "packages/queue/tests/integration/**/*.integration.test.ts",
    ],
    maxWorkers: 1,
  },
});
