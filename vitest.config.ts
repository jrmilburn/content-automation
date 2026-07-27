import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "packages/db/tests/integration/**/*.integration.test.ts"],
  },
});
