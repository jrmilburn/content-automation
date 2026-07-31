import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite shares one bucket, so files must not race each other.
    fileParallelism: false,
    include: ["packages/integrations/tests/integration/**/*.integration.test.ts"],
    maxWorkers: 1,
    // Multipart uploads against a disk-backed container are slower than a unit
    // test; the default 5s timeout is not enough headroom for a cold start.
    testTimeout: 30_000,
  },
});
