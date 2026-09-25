import { expect, test } from "@playwright/test";

// Runs against the production image (scripts/test-image.sh starts it). The dev sign-in is
// deliberately switched on in the container's env; production must ignore it.

test("liveness and database readiness", async ({ request }) => {
  const live = await request.get("/api/health");
  expect(live.status()).toBe(200);
  expect(await live.json()).toEqual({ ok: true });
  const ready = await request.get("/api/health?db=1");
  expect(await ready.json()).toEqual({ ok: true, db: "ok" });
});

test("the landing page renders with its styles and fonts", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Review web pages");
  await expect(page.getByRole("link", { name: "Continue with Google" })).toBeVisible();
  // Static assets come from the standalone server (.next/static was copied in).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(failed).toEqual([]);
});

test("signed-out requests go to Auth0, never to the dev sign-in", async ({ request }) => {
  const pages = await request.get("/pages", { maxRedirects: 0 });
  expect(pages.status()).toBeGreaterThanOrEqual(300);
  expect(pages.headers()["location"]).toContain("/auth/login");

  const login = await request.get("/auth/login", { maxRedirects: 0 });
  expect(login.status()).toBeGreaterThanOrEqual(300);
  const target = new URL(login.headers()["location"]!);
  expect(target.hostname).toMatch(/auth0\.com$/);
  expect(login.headers()["set-cookie"] ?? "").not.toContain("draftpage_dev_session");

  expect((await request.get("/api/pages/aaaaaaaaaa/threads")).status()).toBe(401);
});

test("the frame route exists in the standalone build and requires sign-in", async ({ request }) => {
  // Unauthenticated, so 401, but the route must exist in the standalone build.
  const res = await request.get("/api/versions/00000000-0000-4000-8000-000000000000/frame");
  expect(res.status()).toBe(401);
});
