import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("the authenticated shell is navigable and accessible at its active viewport", async ({
  page,
}) => {
  const response = await page.goto("/");

  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const menuButton = page.getByRole("button", { name: "Menu" });
    await expect(menuButton).toBeVisible();
    const box = await menuButton.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);

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

  const accessibilityScan = await new AxeBuilder({ page }).analyze();
  expect(accessibilityScan.violations).toEqual([]);
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
