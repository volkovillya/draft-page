import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, signInAndCreatePage } from "./helpers";

test.describe("comment composer opens and closes the way people expect", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndCreatePage(page, SAMPLE_HTML);
  });

  const composer = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "New comment" });
  const frame = (page: import("@playwright/test").Page) => page.frameLocator("iframe");

  async function openFromSelection(page: import("@playwright/test").Page) {
    await frame(page).locator("body").click({ position: { x: 20, y: 500 } });
    await frame(page).locator("#intro").selectText();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(composer(page)).toBeVisible();
  }

  test("text selection offers Comment and opens the composer with the quote", async ({ page }) => {
    await openFromSelection(page);
    await expect(composer(page)).toContainText("text “This is a simple HTML page.”");
  });

  test("Esc pressed while focus is inside the page frame closes it", async ({ page }) => {
    await openFromSelection(page);
    await frame(page).locator("body").press("Escape");
    await expect(composer(page)).toBeHidden();
  });

  test("clicking elsewhere closes an empty composer but keeps typed text", async ({ page }) => {
    await openFromSelection(page);
    await frame(page).locator("h1").click();
    await expect(composer(page)).toBeHidden();

    await openFromSelection(page);
    await page.keyboard.type("keep me");
    await frame(page).locator("h1").click();
    await expect(composer(page)).toBeVisible();
  });

  test("the close button discards it", async ({ page }) => {
    await openFromSelection(page);
    await page.getByRole("button", { name: "Discard comment" }).click();
    await expect(composer(page)).toBeHidden();
  });

  test("C (even from inside the frame) enters placing mode, and a click opens the composer", async ({ page }) => {
    await frame(page).locator("body").press("c");
    await expect(page.locator('button[aria-keyshortcuts="C"]')).toHaveAttribute("aria-pressed", "true");
    await frame(page).locator("h1").click();
    await expect(composer(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(composer(page)).toBeHidden();
  });

  test("posting with Send to Claude creates a thread marked as sent to Claude", async ({ page }) => {
    await openFromSelection(page);
    await page.keyboard.type("make this text bold");
    await page.getByText("Send to Claude").click();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("complementary", { name: "Comments" })).toContainText("make this text bold");
    await expect(page.getByRole("complementary", { name: "Comments" })).toContainText(/Sent to Claude|Claude is editing|Claude made v2/);
    await expect(page.getByRole("button", { name: /Thread 1, open/ })).toBeVisible();
  });
});
