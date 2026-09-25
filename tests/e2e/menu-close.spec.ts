import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, signInAndCreatePage } from "./helpers";

test.describe("the page menu", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndCreatePage(page, SAMPLE_HTML);
  });

  const openMenu = async (page: import("@playwright/test").Page) => {
    await page.getByRole("button", { name: /v1/ }).first().click();
    const menu = page.getByRole("menu", { name: "Page menu" });
    await expect(menu).toBeVisible();
    return menu;
  };

  test("closes with Escape", async ({ page }) => {
    const menu = await openMenu(page);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("closes with Escape after the page preview had focus", async ({ page }) => {
    await page.frameLocator("iframe").locator("h1").click();
    const menu = await openMenu(page);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
  });

  test("closes when clicking the page preview (a separate document)", async ({ page }) => {
    const menu = await openMenu(page);
    await page.frameLocator("iframe").locator("#intro").click();
    await expect(menu).toBeHidden();
    // Reopens normally afterwards.
    await expect(await openMenu(page)).toBeVisible();
  });

  test("closes when clicking elsewhere in the app", async ({ page }) => {
    const menu = await openMenu(page);
    await page.getByRole("complementary", { name: "Comments" }).click({ position: { x: 20, y: 200 } });
    await expect(menu).toBeHidden();
  });
});
