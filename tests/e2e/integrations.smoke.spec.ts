import { expect, test } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

test("integration health states are distinct and accessible at the active viewport", async ({
  page,
}) => {
  const response = await page.goto("/settings/integrations");

  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { level: 1, name: "Instagram integration" }),
  ).toBeVisible();

  // The three seeded accounts cover healthy, degraded and blocked at once, so a
  // regression that collapses them into one appearance fails here.
  const badges = page.locator(".integration-account .status-badge");
  await expect(badges.getByText("Connected", { exact: true })).toBeVisible();
  await expect(badges.getByText("Attention needed", { exact: true })).toBeVisible();
  await expect(badges.getByText("Reconnect required", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "@studioparallel" })).toBeVisible();
  await expect(page.getByText(/Business account/u).first()).toBeVisible();

  // A blocked connection links straight to reconnect.
  await expect(page.getByRole("button", { name: "Reconnect account" })).toHaveCount(2);
  const reconnectForm = page.locator('form[action="/api/integrations/instagram/connect"]').first();
  await expect(reconnectForm).toHaveAttribute("method", "post");

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.clientWidth);

    const disconnect = page.getByRole("button", { name: "Disconnect account" }).first();
    const box = await disconnect.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  }

  await expectAccessible(page);
});

test("disconnect asks for confirmation, states the impact and is keyboard reversible", async ({
  page,
}) => {
  await page.goto("/settings/integrations");

  const trigger = page.getByRole("button", { name: "Disconnect account" }).first();
  await trigger.focus();
  await trigger.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Disconnect this Instagram account?" });
  await expect(dialog).toBeVisible();

  // The confirmation must say plainly that history survives, because this is
  // the one control an operator could mistake for a delete.
  await expect(dialog.getByText(/Syncing for @studioparallel stops immediately/u)).toBeVisible();
  await expect(dialog.getByText(/remain available/u)).toBeVisible();

  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await expectAccessible(page);
});

test("the connection callback outcome is reported without provider detail", async ({ page }) => {
  await page.goto("/settings/integrations?instagram=failed");

  await expect(page.getByText("Instagram account was not connected")).toBeVisible();
  await expect(page.getByText(/No account was changed/u)).toBeVisible();

  await page.goto("/settings/integrations?instagram=connected");
  await expect(page.getByText("Instagram account connected")).toBeVisible();

  // A crafted outcome must not be reflected back into the page.
  await page.goto("/settings/integrations?instagram=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  await expect(page.locator(".integration-callback")).toHaveCount(0);

  await expectAccessible(page);
});
