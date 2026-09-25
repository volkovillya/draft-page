import { expect, test } from "@playwright/test";
import { SAMPLE_HTML, createPage, seedForeignPage, shot, signIn } from "./helpers";

test.describe("signed out", () => {
  test("the landing page shows the pitch and a Google sign-in", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Review web pages");
    await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
    await shot(page, "01-landing");
  });

  test("app pages send you to sign in", async ({ page }) => {
    const res = await page.request.get("/pages", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toContain("/auth/login");
  });

  test("the API answers 401 without a session", async ({ page }) => {
    const res = await page.request.get("/api/pages/aaaaaaaaaa/threads");
    expect(res.status()).toBe(401);
  });

  test("the denied page explains the access list and offers sign-out", async ({ page }) => {
    await page.goto("/denied?reason=Not%20on%20the%20list");
    await expect(page.getByRole("heading", { name: /doesn.t have access/ })).toBeVisible();
    await expect(page.getByText("Not on the list")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign out and try again" })).toBeVisible();
    await shot(page, "02-denied");
  });
});

test.describe("signed in", () => {
  test("the landing page redirects to the gallery", async ({ page }) => {
    await signIn(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/pages$/);
  });

  test("the gallery lists your pages and shared pages with status", async ({ page }) => {
    await signIn(page);
    const title = `Gallery mine ${Date.now()}`;
    await createPage(page, SAMPLE_HTML, title);
    const foreign = `Gallery shared ${Date.now()}`;
    await seedForeignPage(foreign, SAMPLE_HTML);
    await page.goto("/pages");
    const mine = page.getByRole("region", { name: /Your pages/ });
    const shared = page.getByRole("region", { name: /Shared with you/ });
    await expect(mine.getByRole("link", { name: new RegExp(title) })).toBeVisible();
    await expect(mine.getByRole("link", { name: new RegExp(title) })).toContainText("Draft v1");
    await expect(shared.getByRole("link", { name: new RegExp(foreign) })).toContainText("Other Reviewer");
    await shot(page, "03-gallery");
  });

  test("a card opens the review canvas", async ({ page }) => {
    await signIn(page);
    const title = `Open me ${Date.now()}`;
    const { shortId } = await createPage(page, SAMPLE_HTML, title);
    await page.goto("/pages");
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page).toHaveURL(new RegExp(`/pages/${shortId}`));
    await expect(page).toHaveTitle(new RegExp(title));
  });

  test("an unknown page is a 404", async ({ page }) => {
    await signIn(page);
    const res = await page.goto("/pages/zzzzzzzzzz");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "This page doesn't exist" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to pages" })).toBeVisible();
    await shot(page, "04-not-found");
    const bad = await page.goto("/pages/not-a-valid-id!");
    expect(bad?.status()).toBe(404);
  });

  test("the gallery pages 24 at a time, mine first", async ({ page }) => {
    await signIn(page);
    const stamp = Date.now();
    for (let i = 0; i < 26; i++) await createPage(page, "<p>x</p>", `Paged ${stamp} ${String(i).padStart(2, "0")}`);
    await page.goto("/pages");
    await expect(page.getByRole("navigation", { name: "Pagination" })).toContainText("Page 1 of");
    await page.getByRole("link", { name: "Older" }).click();
    await expect(page).toHaveURL(/\?p=2/);
    await expect(page.getByRole("navigation", { name: "Pagination" })).toContainText("Page 2 of");
    await expect(page.getByRole("link", { name: "Newer" })).toBeVisible();
  });

  test("a thread can't be opened with a version from another page", async ({ page }) => {
    await signIn(page);
    const a = await createPage(page, SAMPLE_HTML, "A");
    const b = await createPage(page, SAMPLE_HTML, "B");
    await page.goto(`/pages/${b.shortId}`);
    await expect(page.locator("iframe")).toHaveAttribute("src", /\/frame$/);
    const src = await page.locator("iframe").getAttribute("src");
    const versionOfB = src!.split("/")[3]!;
    const res = await page.request.post(`/api/pages/${a.shortId}/threads`, {
      data: { versionId: versionOfB, posX: 0.5, posY: 0.5, text: "wrong page" },
    });
    expect(res.status()).toBe(404);
  });

  test("sign out ends the session", async ({ page }) => {
    await signIn(page);
    await page.goto("/pages");
    await page.getByRole("link", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    const res = await page.request.get("/api/pages/aaaaaaaaaa/threads");
    expect(res.status()).toBe(401);
  });
});
