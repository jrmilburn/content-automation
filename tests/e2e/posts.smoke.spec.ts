import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

test("the posts list is filterable and accessible at the active viewport", async ({ page }) => {
  const response = await page.goto("/posts");

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Posts" })).toBeVisible();

  const results = page.getByRole("region", { name: "Imported posts" });
  await expect(results.getByRole("article")).toHaveCount(4);
  // Scoped to the badge row: the media kind also appears in the source video
  // link's accessible name, which names the post the link belongs to.
  await expect(results.locator(".post-card__meta").getByText("Unsupported media")).toBeVisible();
  await expect(results.getByText("No caption")).toBeVisible();

  // The fixture points every thumbnail at an unreachable signed URL, so the
  // expired-thumbnail fallback is what must render.
  await expect(page.locator(".post-thumbnail--fallback").first()).toBeVisible();

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

test("filters move into the URL and survive as shareable state", async ({ page }) => {
  await page.goto("/posts");

  await page.getByLabel("Media type").selectOption("REEL");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(/kind=REEL/u);
  const results = page.getByRole("region", { name: "Imported posts" });
  await expect(results.getByRole("article")).toHaveCount(2);
  await expect(page.getByLabel("Media type")).toHaveValue("REEL");

  // A filter that matches nothing is its own state, not an empty list.
  await page.getByLabel("Search captions").fill("nothing matches this");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "No posts match these filters" })).toBeVisible();

  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page).toHaveURL(/\/posts$/u);
  await expect(
    page.getByRole("region", { name: "Imported posts" }).getByRole("article"),
  ).toHaveCount(4);

  await expectAccessible(page);
});

test("uncaptured triage signals are named rather than shown as zero", async ({ page }) => {
  await page.goto("/posts");

  const pending = page.getByRole("region", { name: "Not available yet" });
  await expect(pending).toBeVisible();
  for (const label of ["Analysis", "Metrics"]) {
    await expect(pending.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(pending.getByText("Not captured").first()).toBeVisible();

  // Source video is stored state now, so it must not still be listed here.
  await expect(pending.getByText("Source video", { exact: true })).toHaveCount(0);

  await expectAccessible(page);
});

test("a post links through to its own source video upload", async ({ page }) => {
  await page.goto("/posts");

  // The upload page existed before this link did, reachable only by typing a
  // URL. Clicking through from the list is the path a user actually has.
  const card = page.getByRole("region", { name: "Imported posts" }).getByRole("article").first();

  await card.getByRole("link", { name: /Add source video/u }).click();

  await expect(page).toHaveURL(/\/posts\/[0-9a-f-]+\/source-video$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Source video" })).toBeVisible();
  await expect(page.getByLabel("Choose a video")).toBeVisible();
});

test("each source video state is distinguishable on the list", async ({ page }) => {
  await page.goto("/posts");

  const results = page.getByRole("region", { name: "Imported posts" });

  for (const label of [
    "No source video",
    "Checking source video",
    "Source video ready",
    "Source video rejected",
  ]) {
    await expect(results.getByText(label, { exact: true })).toBeVisible();
  }

  await expectAccessible(page);
});

test("a keyboard user can reach and submit the filter form", async ({ page }) => {
  await page.goto("/posts");

  const search = page.getByLabel("Search captions");
  await search.focus();
  await expect(search).toBeFocused();
  await search.fill("lighting");
  await search.press("Enter");

  await expect(page).toHaveURL(/q=lighting/u);
  await expect(
    page.getByRole("region", { name: "Imported posts" }).getByRole("article"),
  ).toHaveCount(1);

  await expectAccessible(page);
});
