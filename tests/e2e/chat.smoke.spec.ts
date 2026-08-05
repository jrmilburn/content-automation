import { expect, test, type Page } from "@playwright/test";

import { expectAccessible } from "./support/accessibility";

/**
 * A whole conversation, in a real browser, against the fake provider.
 *
 * The unit tests prove what `runChatTurn` writes; this proves the part none of
 * them can — that a question typed into a form reaches the model, that the
 * answer comes back through a server action and a revalidation and appears in
 * the document, and that the conversation is still there when the page is
 * reopened. A chat feature whose tests all stop at the command boundary is a
 * chat feature nobody has proved works.
 *
 * Each test makes its own conversation and does not reach for another's. The
 * `APP_ENV=test` store is process-wide and shared by both browser projects, so
 * a test that assumed a particular conversation existed would fail in a way
 * that reads like a product bug rather than like a test that borrowed state.
 * For the same reason every name a test searches for carries its project, since
 * the desktop and mobile runs write into one store concurrently.
 */

const unknownSessionId = "019a0000-0000-7000-8000-0000000009ff";
const citedTrendId = "019a0000-0000-7000-8000-000000000901";

async function startConversation(page: Page): Promise<void> {
  await page.goto("/chat");
  await page.getByRole("button", { name: "Start a conversation" }).click();
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+$/u);
}

test("the assistant answers a question and keeps it in the conversation", async ({ page }) => {
  await startConversation(page);

  await expect(page.getByText(/What video should I make next\?/u)).toBeVisible();

  await page.getByLabel(/Ask about this account/u).fill("What video should I make next?");
  await page.getByRole("button", { name: "Ask" }).click();

  // The question and the answer are both part of the record, in that order.
  await expect(page.getByText("What video should I make next?").first()).toBeVisible();
  await expect(page.getByText(/process and craft pillar/u)).toBeVisible();

  // An answer that cannot be checked is the failure the evidence rule exists to
  // prevent, so the citation must reach the comparison rather than name it.
  const evidence = page.getByRole("link", {
    name: /Question hooks against other hook types/u,
  });
  await expect(evidence).toBeVisible();

  await expectAccessible(page);

  await evidence.click();
  await expect(page).toHaveURL(new RegExp(`/trends/${citedTrendId}$`, "u"));
});

test("a conversation is titled from its first question and can be renamed", async ({
  page,
}, testInfo) => {
  await startConversation(page);
  const conversationUrl = page.url();
  const question = `Which pillar should I test next on ${testInfo.project.name}?`;
  const chosenName = `Winter pillars ${testInfo.project.name}`;

  await page.getByLabel(/Ask about this account/u).fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/process and craft pillar/u)).toBeVisible();

  // A list of conversations all called "New conversation" is a list nobody can
  // use, so the first question names it.
  await expect(page.getByRole("heading", { level: 1, name: question })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Conversation name").fill(chosenName);
  await page.getByRole("button", { name: "Save name" }).click();

  await expect(page.getByRole("heading", { level: 1, name: chosenName })).toBeVisible();

  // Reopening is what makes it a stored conversation rather than a page state.
  await page.goto("/chat");
  await page.getByRole("link", { name: chosenName }).click();
  await expect(page).toHaveURL(conversationUrl);
  await expect(page.getByText(question).first()).toBeVisible();
  await expect(page.getByText(/process and craft pillar/u)).toBeVisible();
});

test("deleting a conversation confirms first, then removes it", async ({ page }, testInfo) => {
  await startConversation(page);
  const question = `Delete me after this on ${testInfo.project.name}`;

  await page.getByLabel(/Ask about this account/u).fill(question);
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText(/process and craft pillar/u)).toBeVisible();

  await page.getByRole("button", { name: "Delete" }).click();

  // The downstream effect is stated before it happens, not after.
  const dialog = page.getByRole("dialog", { name: "Delete this conversation?" });
  await expect(dialog.getByText(/Every message in this conversation is deleted/u)).toBeVisible();
  await expectAccessible(page);

  await dialog.getByRole("button", { name: "Delete conversation" }).click();

  await expect(page).toHaveURL(/\/chat$/u);
  await expect(page.getByRole("link", { name: question })).toHaveCount(0);
});

test("an unknown conversation id discloses nothing", async ({ page }) => {
  await page.goto(`/chat/${unknownSessionId}`);

  // A deleted conversation, another workspace's and one that never existed all
  // read identically, so a crafted id in the address bar confirms nothing. That
  // the three resolve through the same null is proved in the database
  // integration tests; what this asserts is that the screen says no more than
  // the page does, and offers no way to keep asking into it.
  await expect(
    page.getByRole("heading", { level: 1, name: "Conversation not found" }),
  ).toBeVisible();
  await expect(page.getByText(/may belong to another workspace/u)).toBeVisible();
  await expect(page.getByLabel(/Ask about this account/u)).toHaveCount(0);
  await expectAccessible(page);
});

test("the assistant is reachable from the workspace navigation", async ({ page }) => {
  await page.goto("/");

  const viewport = page.viewportSize();
  if (viewport && viewport.width <= 390) {
    await page.getByRole("button", { name: "Menu" }).click();
  }

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Assistant" })
    .first()
    .click();

  await expect(page.getByRole("heading", { level: 1, name: "Assistant" })).toBeVisible();
  await expectAccessible(page);
});
