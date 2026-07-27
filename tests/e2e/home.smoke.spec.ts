import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the built internal shell is usable and has no detectable accessibility violations", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { level: 1, name: "Content intelligence workspace" }),
  ).toBeVisible();

  const accessibilityScan = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScan.violations).toEqual([]);
});
