import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, openCanvas, pinComment, seedForeignPage, shot, signIn } from "./helpers";

test.describe("a page someone else owns", () => {
  let shortId: string;
  let versionId: string;
  test.beforeEach(async ({ page }) => {
    ({ shortId, versionId } = await seedForeignPage(`Foreign ${Date.now()}`, SAMPLE_HTML));
    await signIn(page);
    await openCanvas(page, shortId);
  });

  test("shows no Publish or upload, and names the owner", async ({ page }) => {
    await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeHidden();
    await page.locator("header button[aria-haspopup=menu]").click();
    const menu = page.getByRole("menu", { name: "Page menu" });
    await expect(menu).toContainText("Owned by Other Reviewer");
    await expect(menu.getByRole("menuitem", { name: /Upload new version/ })).toBeHidden();
    await expect(menu.getByRole("menuitem", { name: "Delete page…" })).toBeHidden();
    await shot(page, "30-non-owner");
  });

  test("reviewers can still comment and resolve their own threads", async ({ page }) => {
    await pinComment(page, "h1", "reviewer note");
    const card = page.getByRole("dialog", { name: "Thread 1" });
    await expect(card.getByRole("button", { name: "Resolve thread" })).toBeVisible();
  });

  test("the API refuses publish and new versions from a non-owner", async ({ page }) => {
    expect((await page.request.post(`/api/versions/${versionId}/publish`)).status()).toBe(403);
    expect((await page.request.post(`/api/pages/${shortId}/versions`, { data: { html: SAMPLE_HTML } })).status()).toBe(403);
    expect((await page.request.delete(`/api/pages/${shortId}`)).status()).toBe(403);
  });
});
