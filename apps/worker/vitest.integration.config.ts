import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/worker/tests/integration/**/*.integration.test.ts"],
    // ffmpeg builds every fixture before the first assertion runs, and encoding
    // VP9 is slower than any unit test; the default 5s hook timeout is not
    // enough headroom on a cold machine.
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
