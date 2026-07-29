import { expect, test, type Page } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

/**
 * A Meta app reviewer reaches these documents with no account at all, so the
 * checks below run with a session that the application treats as absent. Any
 * authenticated route redirects to sign-in under this cookie.
 */
async function signOut(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      domain: "127.0.0.1",
      name: "studio-test-session",
      path: "/",
      value: "expired",
    },
  ]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width > 390) return;

  const width = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(width.scrollWidth).toBeLessThanOrEqual(width.clientWidth);
}

test("the privacy policy is readable without a session and states its provider scope", async ({
  page,
}) => {
  await signOut(page);

  const response = await page.goto("/privacy");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/privacy$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();

  await expect(page.getByText("instagram_business_basic")).toBeVisible();
  await expect(page.getByText("instagram_business_manage_insights")).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "team@studioparallel.com.au" }).first(),
  ).toBeVisible();

  // The document must not render workspace chrome or any workspace data.
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("the terms of use are readable without a session", async ({ page }) => {
  await signOut(page);

  const response = await page.goto("/terms");

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/terms$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Terms of use" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  // The in-prose cross-reference must resolve, since the terms rely on it for
  // processing detail. `exact` distinguishes it from the footer link.
  await page.getByRole("link", { exact: true, name: "privacy policy" }).click();
  await expect(page).toHaveURL(/\/privacy$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy policy" })).toBeVisible();
});

test("an authenticated route still redirects under the same signed-out session", async ({
  page,
}) => {
  await signOut(page);

  await page.goto("/operations");

  await expect(page).toHaveURL(/\/login\?reason=session_expired/u);
});

test("the sign-in page links to both documents", async ({ page }) => {
  await page.goto("/login");

  const legal = page.getByRole("navigation", { name: "Legal documents" });

  await expect(legal.getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
    "href",
    "/privacy",
  );
  await expect(legal.getByRole("link", { name: "Terms of use" })).toHaveAttribute("href", "/terms");
});
