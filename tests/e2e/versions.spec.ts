import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { SAMPLE_HTML, SAMPLE_HTML_V2, pinComment, shot, signInAndCreatePage } from "./helpers";

const menuButton = (page: Page) => page.locator("header button[aria-haspopup=menu]");
const menu = (page: Page) => page.getByRole("menu", { name: "Page menu" });
const rail = (page: Page) => page.getByRole("complementary", { name: "Comments" });

async function uploadVersion(page: Page, html: string) {
  await menuButton(page).click();
  await menu(page).getByRole("menuitem", { name: /Upload new version/ }).click();
  const dialog = page.getByRole("dialog", { name: "Upload a new version" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "HTML" }).fill(html);
  await dialog.getByRole("button", { name: "Upload version" }).click();
  await expect(dialog).toBeHidden();
  // Wait for the new version's canvas before touching the header again.
  await expect(menuButton(page)).toContainText(/v[2-9]/);
  await page.waitForTimeout(300);
}

test.describe("versions, publishing and export", () => {
  let shortId: string;
  test.beforeEach(async ({ page }) => {
    shortId = await signInAndCreatePage(page, SAMPLE_HTML);
  });

  test("the page menu lists versions and actions", async ({ page }) => {
    await menuButton(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(menu(page)).toContainText("Version 1");
    await expect(menu(page)).toContainText("You own this page");
    await shot(page, "20-page-menu");
    await page.keyboard.press("Escape");
    await expect(menu(page)).toBeHidden();
  });

  test("the menu supports arrow keys", async ({ page }) => {
    await menuButton(page).click();
    const items = menu(page).getByRole("menuitem");
    await expect(items.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(items.last()).toBeFocused();
  });

  test("uploading a version opens it, and open threads carry over", async ({ page }) => {
    await pinComment(page, "h1", "carry me");
    await uploadVersion(page, SAMPLE_HTML_V2);
    await expect(page).toHaveURL(new RegExp(`/pages/${shortId}\\?n=2`));
    await expect(menuButton(page)).toContainText("v2");
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Hello again" })).toBeVisible();
    await expect(rail(page)).toContainText("carry me");
    await expect(rail(page)).toContainText("from v1");
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeVisible();
    await shot(page, "21-v2-carried");
  });

  test("an earlier version is read-only with a link to the newest", async ({ page }) => {
    await pinComment(page, "h1", "old thread");
    await uploadVersion(page, SAMPLE_HTML_V2);
    await menuButton(page).click();
    await menu(page).getByRole("menuitem", { name: /Version 1/ }).click();
    await expect(page).toHaveURL(/\?n=1/);
    await expect(page.getByRole("status").filter({ hasText: "earlier version" })).toBeVisible();
    await expect(page.locator('button[aria-keyshortcuts="C"]')).toBeHidden();
    await page.getByRole("button", { name: "Thread 1, open" }).click();
    const card = page.getByRole("dialog", { name: "Thread 1" });
    await expect(card).toContainText("Read-only on earlier versions.");
    await expect(card.getByRole("button", { name: "Resolve thread" })).toBeHidden();
    // Publishing from an older version says which version goes live.
    await expect(page.getByRole("button", { name: "Publish v1", exact: true })).toBeVisible();
    await shot(page, "22-old-version");
    // C does nothing on an old version.
    await page.keyboard.press("Escape");
    await page.keyboard.press("c");
    await expect(page.getByText("Click anywhere to comment")).toBeHidden();
    await page.getByRole("link", { name: "Open v2" }).click();
    await expect(page).toHaveURL(/\?n=2/);
  });

  test("the upload dialog validates and can be cancelled with Esc", async ({ page }) => {
    await menuButton(page).click();
    await menu(page).getByRole("menuitem", { name: /Upload new version/ }).click();
    const dialog = page.getByRole("dialog", { name: "Upload a new version" });
    await shot(page, "23-upload-dialog");
    await dialog.getByRole("button", { name: "Upload version" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Paste HTML or choose a file");
    // C typed in the dialog must not toggle placing mode.
    await dialog.getByRole("textbox", { name: "HTML" }).pressSequentially("c");
    await expect(page.locator('button[aria-keyshortcuts="C"]')).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Reopening starts clean enough to use again.
    await menuButton(page).click();
    await menu(page).getByRole("menuitem", { name: /Upload new version/ }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("the upload dialog accepts a file", async ({ page }) => {
    await menuButton(page).click();
    await menu(page).getByRole("menuitem", { name: /Upload new version/ }).click();
    const dialog = page.getByRole("dialog", { name: "Upload a new version" });
    await dialog.locator("input[type=file]").setInputFiles({ name: "v2.html", mimeType: "text/html", buffer: Buffer.from(SAMPLE_HTML_V2) });
    await expect(dialog).toContainText("v2.html");
    await dialog.getByRole("button", { name: "Upload version" }).click();
    await expect(page).toHaveURL(/\?n=2/);
  });

  test("publish makes the version live; unpublish returns it to draft", async ({ page }) => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.locator("header")).toContainText("Live");
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await shot(page, "24-live");
    await page.goto("/pages");
    await expect(page.getByRole("link").filter({ has: page.getByText("Live v1") }).first()).toBeVisible();
    await page.goBack();
    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    await expect(page.locator("header")).toContainText("Draft");
  });

  test("publishing v2 moves Live off v1, and the page opens on the live version", async ({ page }) => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await uploadVersion(page, SAMPLE_HTML_V2);
    await expect(page).toHaveURL(/\?n=2/);
    await expect(menuButton(page)).toContainText("v2");
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await menuButton(page).click();
    const v1 = menu(page).getByRole("menuitem", { name: /Version 1/ });
    await expect(v1).toContainText("Draft");
    await page.keyboard.press("Escape");
    await page.goto(`/pages/${shortId}`);
    await expect(menuButton(page)).toContainText("v2");
  });

  test("export downloads a Markdown digest of the review", async ({ page }) => {
    await pinComment(page, "h1", "Exported comment");
    await menuButton(page).click();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      menu(page).getByRole("menuitem", { name: /Export review/ }).click(),
    ]);
    const md = await readFile((await download.path())!, "utf8");
    expect(md).toContain("# Review:");
    expect(md).toContain("Exported comment");
    expect(md).toContain(`/pages/${shortId}?n=1`);
    expect(download.suggestedFilename()).toBe(`review-${shortId}-v1.md`);
  });

  test("the owner can delete the page after confirming", async ({ page }) => {
    await menuButton(page).click();
    page.once("dialog", (d) => void d.dismiss());
    await menu(page).getByRole("menuitem", { name: "Delete page…" }).click();
    await expect(page).toHaveURL(new RegExp(`/pages/${shortId}`));

    await menuButton(page).click();
    page.once("dialog", (d) => {
      expect(d.message()).toContain("can't be undone");
      void d.accept();
    });
    await menu(page).getByRole("menuitem", { name: "Delete page…" }).click();
    await expect(page).toHaveURL(/\/pages$/);
    const res = await page.goto(`/pages/${shortId}`);
    expect(res?.status()).toBe(404);
  });

  test("going Back after publishing shows the current state", async ({ page }) => {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
    await page.getByRole("link", { name: "Back to pages" }).click();
    await expect(page).toHaveURL(/\/pages$/);
    await page.goBack();
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();
  });
});

