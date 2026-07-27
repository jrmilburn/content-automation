import process from "node:process";

import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:3210";

export default defineConfig({
  expect: {
    timeout: 5_000,
  },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  outputDir: "artifacts/playwright/runtime",
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { height: 844, width: 390 },
      },
    },
  ],
  reporter: [["line"], ["junit", { outputFile: "artifacts/playwright/results.xml" }]],
  retries: process.env.CI ? 1 : 0,
  testDir: "tests/e2e",
  timeout: 30_000,
  use: {
    baseURL,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "npm run start:web",
    env: {
      ...process.env,
      APP_ENV: "test",
      PORT: "3210",
      PROVIDER_MODE: "fake",
      PUBLIC_ORIGIN: baseURL,
    },
    reuseExistingServer: false,
    timeout: 120_000,
    url: `${baseURL}/api/health`,
  },
});
