import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, createPage, openCanvas, pinComment, shot, signIn } from "./helpers";

test.describe("layout across screens and themes", () => {
  test("light mode renders the gallery and canvas", async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await signIn(page);
    const { shortId } = await createPage(page, SAMPLE_HTML, `Light ${Date.now()}`);
    await page.goto("/pages");
    await shot(page, "40-light-gallery");
    await openCanvas(page, shortId);
    await pinComment(page, "h1", "Light mode comment");
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeVisible();
    await shot(page, "41-light-canvas");
    await page.goto("/");
    await context.close();
  });

  test("on a phone the canvas has no horizontal scroll and comments stay reachable", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: "dark" });
    const page = await context.newPage();
    await signIn(page);
    const { shortId } = await createPage(page, SAMPLE_HTML, `A rather long page title for a phone ${Date.now()}`);
    await page.goto("/pages");
    await shot(page, "42-phone-gallery");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await openCanvas(page, shortId);
    await shot(page, "43-phone-canvas");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    // The comment toggle in the header must reveal the comments somewhere on a phone.
    await page.locator('header button[title$="comments"]').click();
    await expect(page.getByRole("complementary", { name: "Comments" })).toBeVisible();
    await context.close();
  });

  test("on a phone the landing page fits", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto("/");
    await shot(page, "44-phone-landing");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await context.close();
  });

  test("a very long title truncates in the header instead of pushing Publish off-screen", async ({ page }) => {
    await signIn(page);
    const { shortId } = await createPage(page, SAMPLE_HTML, "Long ".repeat(38).trim());
    await page.setViewportSize({ width: 900, height: 700 });
    await openCanvas(page, shortId);
    await expect(page.getByRole("button", { name: "Publish" })).toBeInViewport();
    await shot(page, "45-long-title");
  });
});
