import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

const postId = "019a0000-0000-7000-8000-000000000401";

test("the source video upload states the limits and stays usable at the active viewport", async ({
  page,
}) => {
  const response = await page.goto(`/posts/${postId}/source-video`);

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Source video" })).toBeVisible();

  // Formats and the ceiling are stated before a file is chosen, so a user is
  // not told after a long upload that the file was never eligible.
  await expect(page.getByText(/MP4, MOV or WebM, up to 1 GB/u)).toBeVisible();
  await expect(page.getByText("No video selected")).toBeVisible();

  // Upload and validation are named separately, so a finished upload is never
  // mistaken for a video that is ready to analyse.
  await expect(page.getByText("1. Upload")).toBeVisible();
  await expect(page.getByText("2. Validation")).toBeVisible();

  const chooser = page.getByLabel("Choose a video");
  await expect(chooser).toBeVisible();

  const accept = await page.locator("#video-upload-input").getAttribute("accept");
  expect(accept).toContain("video/mp4");
  expect(accept).not.toContain("video/x-msvideo");

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

test("an unknown post does not reveal whether it exists elsewhere", async ({ page }) => {
  // A well-formed identifier for a post this workspace cannot see, and a
  // malformed one, must be indistinguishable. The assertion is on what is
  // rendered rather than the status code, because the app streams its shell and
  // the status is already committed by the time the lookup resolves — the same
  // behaviour the existing job detail route has.
  for (const candidate of ["019a0000-0000-7000-8000-0000000009ff", "not-a-post-id"]) {
    await page.goto(`/posts/${candidate}/source-video`);

    await expect(page.getByRole("heading", { name: "Post not found" })).toBeVisible();
    await expect(page.getByText(/No post data was disclosed/u)).toBeVisible();

    // No upload may be startable for a post the caller cannot see.
    await expect(page.getByLabel("Choose a video")).toHaveCount(0);
  }
});
