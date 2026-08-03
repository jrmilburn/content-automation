import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

const supportedTrendId = "019a0000-0000-7000-8000-000000000901";
const outlierTrendId = "019a0000-0000-7000-8000-000000000904";

test("trends are grouped by evidence strength and accessible at the active viewport", async ({
  page,
}) => {
  const response = await page.goto("/trends");

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Trends" })).toBeVisible();

  // Every section is present even when empty: an absent heading reads as "there
  // were none", which is indistinguishable from "we did not look".
  for (const heading of [
    "Supported associations",
    "Directional signals",
    "Outliers and counterexamples",
    "Not enough evidence",
  ]) {
    await expect(page.getByRole("region", { name: heading })).toBeVisible();
  }

  const supported = page.getByRole("region", { name: "Supported associations" });
  await expect(supported.getByRole("article")).toHaveCount(2);
  await expect(supported.getByText("Statistically supported").first()).toBeVisible();

  // The strong badge maps only to the supported class. A moderate association is
  // a finding, not a strong one.
  const directional = page.getByRole("region", { name: "Directional signals" });
  await expect(directional.getByText("Statistically supported")).toHaveCount(0);

  await expect(page.getByText("Calculation is current")).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

    const apply = page.getByRole("button", { name: "Apply filters" });
    const box = await apply.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }

  await expectAccessible(page);
});

test("trend filters move into the URL and survive as shareable state", async ({ page }) => {
  await page.goto("/trends");

  await page.getByLabel("Evidence level").selectOption("single_post_outlier");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(/confidence=single_post_outlier/u);
  await expect(page.getByLabel("Evidence level")).toHaveValue("single_post_outlier");
  await expect(
    page.getByRole("region", { name: "Outliers and counterexamples" }).getByRole("article"),
  ).toHaveCount(1);
  await expect(
    page.getByRole("region", { name: "Supported associations" }).getByRole("article"),
  ).toHaveCount(0);

  // A filter that matches nothing is its own state, and it must not read as a
  // conclusion that the account has no patterns.
  await page.getByLabel("Metric").selectOption("follow_conversion_rate");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(
    page.getByRole("heading", { name: "No comparisons match these filters" }),
  ).toBeVisible();
  await expect(page.getByText(/not a finding that no pattern exists/u)).toBeVisible();

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/trends$/u);
  await expectAccessible(page);
});

test("a keyboard user can reach and submit the trend filters", async ({ page }) => {
  await page.goto("/trends");

  const evidence = page.getByLabel("Evidence level");
  await evidence.selectOption("weak_directional_signal");

  // The form has no text field, so there is no implicit submission to press
  // Enter into. What matters is that the submit button is reachable by tabbing
  // from the last control rather than only by pointer.
  await evidence.press("Tab");
  const apply = page.getByRole("button", { name: "Apply filters" });
  await expect(apply).toBeFocused();
  await apply.press("Enter");

  await expect(page).toHaveURL(/confidence=weak_directional_signal/u);
});

test("the evidence detail shows the comparison as a table, not a chart", async ({ page }) => {
  await page.goto(`/trends/${supportedTrendId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Hook type: Question" })).toBeVisible();

  const comparison = page.getByRole("region", { name: "The comparison" });
  await expect(comparison.getByRole("table")).toBeVisible();
  await expect(comparison.getByRole("rowheader", { name: "Posts with Question" })).toBeVisible();
  await expect(
    comparison.getByRole("rowheader", { name: "Posts with another value" }),
  ).toBeVisible();

  // The formula and denominator travel with the number, so a rate cannot be read
  // as a count or as a rate of something else.
  const method = page.getByRole("region", { name: "How it was calculated" });
  await expect(method.getByText("Metric formula")).toBeVisible();
  await expect(method.getByText("Denominator")).toBeVisible();

  // Both sides are inspectable. Showing only the supporting posts would let a
  // positive claim hide its own counterexamples.
  await expect(page.getByRole("region", { name: "Posts with this value" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Posts compared against" })).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    // A four-column table scrolls inside its own wrapper. The document must not
    // widen, or every screen on the page gains a horizontal scrollbar.
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
  }

  await expectAccessible(page);
});

test("an outlier names what carries it rather than reading as a pattern", async ({ page }) => {
  await page.goto(`/trends/${outlierTrendId}`);

  await expect(page.getByText("Single-post outlier")).toBeVisible();
  await expect(page.getByText(/it is not a pattern/u)).toBeVisible();
  await expect(page.getByText(/One post accounts for 72%/u)).toBeVisible();

  // An uncalculated interval says so. A dash would be read as a precise result.
  await expect(page.getByText(/Not calculated/u)).toBeVisible();

  await expectAccessible(page);
});

test("an unknown comparison does not reveal whether it exists elsewhere", async ({ page }) => {
  await page.goto("/trends/019a0000-0000-7000-8000-0000000009ff");

  await expect(page.getByRole("heading", { name: "Comparison not available" })).toBeVisible();
  await expect(page.getByText(/No data was disclosed/u)).toBeVisible();

  await expectAccessible(page);
});
