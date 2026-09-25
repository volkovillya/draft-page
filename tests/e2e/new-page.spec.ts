import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, shot, signIn } from "./helpers";

test.describe("creating a page", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, "/pages/new");
    await expect(page.getByRole("heading", { name: "New page" })).toBeVisible();
  });

  test("the gallery's New page button opens the form", async ({ page }) => {
    await page.goto("/pages");
    await page.getByRole("link", { name: "New page" }).click();
    await expect(page).toHaveURL(/\/pages\/new$/);
    await shot(page, "05-new-page");
  });

  test("uploading a file fills the title from the file name and creates v1", async ({ page }) => {
    await page.getByLabel("HTML file").setInputFiles({
      name: "Pricing redesign.html",
      mimeType: "text/html",
      buffer: Buffer.from(SAMPLE_HTML),
    });
    await expect(page.getByLabel("Title")).toHaveValue("Pricing redesign");
    await expect(page.getByText("Pricing redesign.html")).toBeVisible();
    await shot(page, "06-new-page-file");
    await page.getByRole("button", { name: "Create page" }).click();
    await expect(page).toHaveURL(/\/pages\/[a-z0-9]{10}$/);
    await expect(page.getByRole("button", { name: "Page menu" }).or(page.locator("button[aria-haspopup=menu]"))).toContainText("v1");
  });

  test("pasting HTML creates a page", async ({ page }) => {
    await page.getByRole("tab", { name: "Paste" }).click();
    await page.getByRole("textbox", { name: "HTML" }).fill(SAMPLE_HTML);
    await page.getByLabel("Title").fill("Pasted page");
    await page.getByRole("button", { name: "Create page" }).click();
    await expect(page).toHaveURL(/\/pages\/[a-z0-9]{10}$/);
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Hello" })).toBeVisible();
  });

  test("Create is disabled until there is HTML and a title", async ({ page }) => {
    const create = page.getByRole("button", { name: "Create page" });
    await expect(create).toBeDisabled();
    await page.getByRole("tab", { name: "Paste" }).click();
    await page.getByRole("textbox", { name: "HTML" }).fill(SAMPLE_HTML);
    await expect(create).toBeDisabled();
    await page.getByLabel("Title").fill("   ");
    await expect(create).toBeDisabled();
    await page.getByLabel("Title").fill("Now valid");
    await expect(create).toBeEnabled();
  });

  test("a non-HTML file is rejected with a message", async ({ page }) => {
    await page.getByLabel("HTML file").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello"),
    });
    await expect(page.locator("form [role=alert]")).toHaveText("Choose an .html file.");
  });

  test("an empty HTML file is rejected with a message", async ({ page }) => {
    await page.getByLabel("HTML file").setInputFiles({ name: "empty.html", mimeType: "text/html", buffer: Buffer.from("   ") });
    await expect(page.locator("form [role=alert]")).toHaveText("That file is empty.");
  });

  test("a file over 2 MiB is rejected before upload", async ({ page }) => {
    await page.getByLabel("HTML file").setInputFiles({
      name: "big.html",
      mimeType: "text/html",
      buffer: Buffer.alloc(2 * 1024 * 1024 + 10, "a"),
    });
    await expect(page.locator("form [role=alert]")).toContainText("limit is 2 MiB");
  });

  test("switching tabs keeps what was pasted", async ({ page }) => {
    await page.getByRole("tab", { name: "Paste" }).click();
    await page.getByRole("textbox", { name: "HTML" }).fill("<p>keep</p>");
    await page.getByRole("tab", { name: "File" }).click();
    await page.getByRole("tab", { name: "Paste" }).click();
    await expect(page.getByRole("textbox", { name: "HTML" })).toHaveValue("<p>keep</p>");
  });

  test("Cancel goes back to the gallery", async ({ page }) => {
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/pages$/);
  });
});
