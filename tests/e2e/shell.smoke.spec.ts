import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

test("the authenticated shell is navigable and accessible at its active viewport", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  // The dashboard reflects the connected account the fixtures describe; it
  // previously reported "not connected" no matter what the data said.
  const setupAction = page.getByRole("link", { name: "Review connection" });
  await expect(setupAction).toBeVisible();
  await expect(setupAction).toHaveAttribute("href", "/settings/integrations");
  await expect(page.getByText("@studioparallel").first()).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

    const menuButton = page.getByRole("button", { name: "Menu" });
    await expect(menuButton).toBeVisible();
    const box = await menuButton.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    const setupBox = await setupAction.boundingBox();
    expect(setupBox).not.toBeNull();
    expect((setupBox?.x ?? 0) + (setupBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);

    await menuButton.focus();
    await menuButton.press("Enter");
    const navigationDialog = page.getByRole("dialog", { name: "Workspace navigation" });
    await expect(navigationDialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(navigationDialog).toBeHidden();
    await expect(menuButton).toBeFocused();

    await menuButton.press("Enter");
    await expect(navigationDialog).toBeVisible();
    await page
      .getByRole("dialog", { name: "Workspace navigation" })
      .getByRole("link", { name: "Posts" })
      .click();
  } else {
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Posts" })
      .click();
  }

  await expect(page).toHaveURL(/\/posts$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Posts" })).toBeVisible();
  if (viewport && viewport.width <= 390) {
    await page.getByRole("button", { name: "Menu" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Workspace navigation" })
        .getByRole("link", { name: "Posts" }),
    ).toHaveAttribute("aria-current", "page");
  } else {
    await expect(page.getByRole("link", { name: "Posts" })).toHaveAttribute("aria-current", "page");
  }

  await expectAccessible(page);
});

test("an expired session redirects before workspace content renders", async ({ context, page }) => {
  await context.addCookies([
    {
      domain: "127.0.0.1",
      name: "studio-test-session",
      path: "/",
      value: "expired",
    },
  ]);

  await page.goto("/operations");

  await expect(page).toHaveURL(/\/login\?reason=session_expired&returnTo=%2F$/u);
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Content intelligence, with the evidence attached.",
    }),
  ).toBeVisible();
  await expect(page.getByText(/No workspace data was shown/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toHaveCount(0);
});

test("operations filters and safe job detail remain accessible at the active viewport", async ({
  page,
}) => {
  const response = await page.goto("/operations");
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
  const ledger = page.locator(".job-ledger");
  const statuses = ledger.locator(".status-badge");
  await expect(statuses.getByText("Queued", { exact: true })).toBeVisible();
  await expect(statuses.getByText("Processing", { exact: true })).toBeVisible();
  await expect(statuses.getByText("Retry scheduled", { exact: true })).toBeVisible();
  await expect(statuses.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(statuses.getByText("Completed", { exact: true })).toBeVisible();
  await expect(statuses.getByText("Cancelled", { exact: true })).toBeVisible();

  await page.getByLabel("State").selectOption("FAILED_ATTENTION");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("heading", { name: "Current jobs" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("state")).toBe("FAILED_ATTENTION");
  await expect(page.getByRole("link", { name: "View detail" })).toHaveCount(1);

  const detailLink = page.getByRole("link", { name: "View detail" });
  await detailLink.focus();
  await detailLink.press("Enter");
  await expect(page).toHaveURL(/\/operations\/jobs\/019a0000-0000-7000-8000-000000000101$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Job detail" })).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry once" })).toBeVisible();
  await expect(page.getByText(/Existing completed data remains safe/)).toBeVisible();
  await expect(page.getByText(/No provider usage was recorded/)).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);
    const retryBox = await page.getByRole("button", { name: "Retry once" }).boundingBox();
    expect(retryBox).not.toBeNull();
    expect((retryBox?.x ?? 0) + (retryBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }

  await expectAccessible(page);
});
