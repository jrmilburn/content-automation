import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

/**
 * What a reader can see and do on a strategy, in a real browser.
 *
 * The order of the sections and the adjacency of a sample size to its claim are
 * the whole point of this screen, and both are properties of the rendered
 * document rather than of a component in isolation. So is a citation that opens
 * the trend behind it: a link that renders but resolves nowhere is exactly the
 * failure the evidence requirement exists to prevent.
 */

const strategyId = "019a0000-0000-7000-8000-0000000005a1";
const unknownStrategyId = "019a0000-0000-7000-8000-0000000005ff";
const citedTrendId = "019a0000-0000-7000-8000-000000000901";

test("the strategy leads with decisions and closes with limitations", async ({ page }) => {
  const response = await page.goto("/strategy");

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Strategy" })).toBeVisible();

  // Fixed by the acceptance criteria: a reader who stops early must have read
  // the decisions, and one who reads on must reach the caveats before acting.
  const headings = await page.getByRole("heading", { level: 2 }).allTextContents();

  expect(headings).toEqual([
    "Generate a strategy",
    "Lead with the question, keep the build visible",
    "What is working",
    "What is not working",
    "What to test next",
    "Videos to make next",
    "Where to spend the next posts",
    "What this cannot tell you",
    "Previous strategies",
  ]);

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
  }

  await expectAccessible(page);
});

test("the preview names the period and metric the counts describe", async ({ page }) => {
  await page.goto("/strategy");

  const request = page.getByRole("region", { name: "Generate a strategy" });

  // Without these two, "20 comparable posts" names no window and no measure,
  // and a reader is agreeing to a document they cannot describe.
  await expect(request.getByText("4 Feb 2026 to 4 Aug 2026")).toBeVisible();
  await expect(request.getByText("Evidence-led")).toBeVisible();
  await expect(request.getByRole("button", { name: "Generate a strategy" })).toBeVisible();
});

test("a claim keeps its sample size and opens the trend behind it", async ({ page }) => {
  await page.goto("/strategy");

  const claim = page.getByRole("article", { name: /Question hooks appear associated/u });

  await expect(claim.getByText("Appears associated in this account")).toBeVisible();
  await expect(claim.getByText("12 posts")).toBeVisible();

  // The citation has to reach the calculation, not merely name it.
  await claim.getByRole("link", { name: "stat_pos_0" }).click();
  await expect(page).toHaveURL(new RegExp(`/trends/${citedTrendId}$`, "u"));
});

test("evidence that has gone says so instead of being replaced", async ({ page }) => {
  await page.goto("/strategy");

  const limitations = page.getByRole("region", { name: "What this cannot tell you" });

  await expect(limitations.getByText(/no longer available/u)).toBeVisible();
});

test("a ready-to-film idea is labelled a creative proposal", async ({ page }) => {
  await page.goto("/strategy");

  const recommendation = page.getByRole("article", { name: /Show the joint that failed/u });

  // The easiest thing on the page to mistake for a finding, so the label sits
  // beside it rather than in a legend further down.
  await expect(recommendation.getByText("Creative proposal")).toBeVisible();
});

test("a strategy opens by its own id, and an unknown id discloses nothing", async ({ page }) => {
  await page.goto(`/strategy/${strategyId}`);

  await expect(
    page.getByRole("heading", { level: 2, name: "Lead with the question, keep the build visible" }),
  ).toBeVisible();
  await expectAccessible(page);

  await page.goto(`/strategy/${unknownStrategyId}`);

  // Another workspace's strategy and one that never existed read identically:
  // the reader is not told which, so a crafted id confirms nothing. That both
  // resolve through the same null is proved in the database integration tests;
  // what this asserts is that the screen says nothing more than the page does.
  await expect(page.getByRole("heading", { level: 1, name: "Strategy not found" })).toBeVisible();
  await expect(page.getByText(/may belong to another workspace/u)).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(0);
  await expectAccessible(page);
});
