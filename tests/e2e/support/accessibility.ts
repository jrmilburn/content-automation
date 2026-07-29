import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * Scans the current page once the document has settled.
 *
 * App Router soft navigation swaps the document title asynchronously, so a scan
 * fired immediately after a client-side click can report a transient
 * missing-title violation that no user ever experiences. Waiting for a non-empty
 * title first makes the check deterministic under parallel load without
 * weakening what it asserts.
 */
export async function expectAccessible(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.title()).trim().length, { timeout: 5_000 })
    .toBeGreaterThan(0);

  const accessibilityScan = await new AxeBuilder({ page }).analyze();

  expect(accessibilityScan.violations).toEqual([]);
}
