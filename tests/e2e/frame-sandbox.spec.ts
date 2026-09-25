import { expect, test } from "@playwright/test";
import { createPage, openCanvas, signIn } from "./helpers";

// The page under review is untrusted. It runs, but in an opaque origin with no way into the app.
const HOSTILE_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:40px">
<h1 id="h">Hostile</h1><p id="parent"></p><p id="cookie"></p><p id="fetch"></p><p id="storage"></p>
<form id="f" action="/api/pages" method="post"><button id="submit">Submit</button></form>
<script>
  try { document.getElementById("parent").textContent = "parent:" + parent.document.title; }
  catch (e) { document.getElementById("parent").textContent = "parent:blocked"; }
  try { document.getElementById("cookie").textContent = "cookie:" + (document.cookie || "none"); }
  catch (e) { document.getElementById("cookie").textContent = "cookie:blocked"; }
  try { localStorage.setItem("x", "1"); document.getElementById("storage").textContent = "storage:open"; }
  catch (e) { document.getElementById("storage").textContent = "storage:blocked"; }
  fetch("/api/pages", { credentials: "include" })
    .then(r => r.text()).then(t => { document.getElementById("fetch").textContent = "fetch:read " + t.slice(0, 20); })
    .catch(() => { document.getElementById("fetch").textContent = "fetch:blocked"; });
  // Spoofing a bridge message must not open the composer.
  parent.postMessage({ dp: 1, type: "pick", posX: 0.5, posY: 0.5, targetPath: "body", excerpt: null, clientX: 100, clientY: 100 }, "*");
</script></body></html>`;

test.describe("the sandboxed page frame", () => {
  test("page scripts run but can't reach the app, its cookies, storage or API", async ({ page }) => {
    await signIn(page);
    const { shortId } = await createPage(page, HOSTILE_HTML);
    await openCanvas(page, shortId);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("#parent")).toHaveText("parent:blocked");
    await expect(frame.locator("#cookie")).toHaveText("cookie:blocked");
    await expect(frame.locator("#storage")).toHaveText("storage:blocked");
    await expect(frame.locator("#fetch")).toHaveText("fetch:blocked");
    await expect(page.getByRole("dialog", { name: "New comment" })).toBeHidden();
  });

  test("forms inside the page can't submit", async ({ page }) => {
    await signIn(page);
    const { shortId } = await createPage(page, HOSTILE_HTML);
    await openCanvas(page, shortId);
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.frameLocator("iframe").locator("#submit").click();
    await page.waitForTimeout(800);
    expect(posts).toEqual([]);
  });

  test("the frame route is served sandboxed and can't be framed by other sites", async ({ page }) => {
    await signIn(page);
    const { shortId } = await createPage(page, HOSTILE_HTML);
    await openCanvas(page, shortId);
    const src = await page.locator("iframe").getAttribute("src");
    const res = await page.request.get(src!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  });

  test("a page that navigates its frame pauses comments and can be restored", async ({ page }) => {
    await signIn(page);
    const html = `<!doctype html><html><body style="padding:40px"><h1>Nav</h1>
      <a id="go" href="about:blank#elsewhere">Go elsewhere</a><a id="self" href="?x=1">Reload self</a></body></html>`;
    const { shortId } = await createPage(page, html);
    await openCanvas(page, shortId);
    await page.frameLocator("iframe").locator("#self").click();
    await expect(page.getByText("comments are paused")).toBeVisible();
    await page.getByRole("button", { name: "Reload preview" }).click();
    await expect(page.getByText("comments are paused")).toBeHidden();
    await expect(page.frameLocator("iframe").getByRole("heading", { name: "Nav" })).toBeVisible();
    await page.waitForTimeout(500);
    await page.keyboard.press("c");
    await page.frameLocator("iframe").locator("h1").click();
    await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  });
});
