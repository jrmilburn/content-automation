import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react({})],
  resolve: {
    alias: {
      // See apps/web/src/test/server-only-stub.ts.
      "server-only": "/apps/web/src/test/server-only-stub.ts",
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      "packages/db/tests/integration/**/*.integration.test.ts",
      "packages/integrations/tests/integration/**/*.integration.test.ts",
      "packages/queue/tests/integration/**/*.integration.test.ts",
      "tests/e2e/**",
    ],
    setupFiles: ["./apps/web/src/test/setup.ts"],
  },
});
