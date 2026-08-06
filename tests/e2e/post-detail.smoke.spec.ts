import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

/** The fixture post that carries every section, including a metric nobody measured. */
const fullPostId = "019a0000-0000-7000-8000-000000000401";
/** The fixture post with nothing stored beyond its identity. */
const barePostId = "019a0000-0000-7000-8000-000000000403";

test("the post detail page carries identity, metrics, analysis and comments", async ({ page }) => {
  const response = await page.goto(`/posts/${fullPostId}`);

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: /Reel published/u })).toBeVisible();

  for (const heading of ["This post", "Performance", "Analysis", "Comments"]) {
    await expect(page.getByRole("heading", { level: 2, name: heading })).toBeVisible();
  }

  await expect(page.getByRole("link", { name: /View on Instagram/u })).toBeVisible();
  await expect(page.getByText(/Three lighting mistakes/u).first()).toBeVisible();

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

test("a metric the provider never reported is named rather than shown as zero", async ({
  page,
}) => {
  await page.goto(`/posts/${fullPostId}`);

  // Meta documents an unavailable insight as empty data rather than as a zero,
  // so a "0" here would be a claim nobody made. The fixture reports no average
  // watch time precisely so this row is reachable without a real import.
  const row = page.getByRole("row", { name: /Average watch time/u });
  await expect(row).toContainText("Not measured");
  await expect(page.getByText(/It is not a count of zero/u)).toBeVisible();

  await expectAccessible(page);
});

test("the transcript is labelled as a model's work before it can be read", async ({ page }) => {
  await page.goto(`/posts/${fullPostId}`);

  await expect(page.getByRole("heading", { level: 3, name: "Transcript" })).toBeVisible();
  await expect(page.getByText("Model-generated")).toBeVisible();
  await expect(page.getByText(/not a verbatim record/u)).toBeVisible();

  await expectAccessible(page);
});

test("what has not been captured is named rather than left blank", async ({ page }) => {
  // Fixture 403 has no analysis, no snapshot and no comments. Three absences
  // that each need their own words: a blank section reads as "nothing
  // happened", which is a different claim from "nothing was captured".
  await page.goto(`/posts/${barePostId}`);

  await expect(page.getByText(/No metrics have been captured/u)).toBeVisible();
  await expect(page.getByText(/has not been analysed/u)).toBeVisible();
  await expect(page.getByText(/No comments have been imported/u)).toBeVisible();

  await expectAccessible(page);
});

test("an unknown post does not reveal whether it exists elsewhere", async ({ page }) => {
  // A well-formed identifier for a post this workspace cannot see, and a
  // malformed one, must be indistinguishable. The assertion is on what is
  // rendered rather than the status code, because the app streams its shell and
  // the status is already committed by the time the lookup resolves.
  for (const candidate of ["019a0000-0000-7000-8000-0000000009ff", "not-a-post-id"]) {
    await page.goto(`/posts/${candidate}`);

    await expect(page.getByRole("heading", { name: "Post not found" })).toBeVisible();
    await expect(page.getByText(/No post data was disclosed/u)).toBeVisible();
  }
});

test("a card on the list opens the post it belongs to", async ({ page }) => {
  await page.goto("/posts");

  const card = page.getByRole("region", { name: "Imported posts" }).getByRole("article").first();
  await card.getByRole("link", { name: /See everything/u }).click();

  await expect(page).toHaveURL(/\/posts\/[0-9a-f-]+$/u);
  await expect(page.getByRole("heading", { level: 2, name: "Performance" })).toBeVisible();
});
