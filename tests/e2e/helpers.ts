import { expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./global-setup";

/** Signs in with the dev sign-in (e2e server only). */
export async function signIn(page: Page, returnTo = "/pages") {
  await page.goto(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
}

/** Creates a page through the API as the signed-in dev member. */
export async function createPage(page: Page, html: string, title = `E2E ${Date.now()}`) {
  const res = await page.request.post("/api/pages", { data: { title, html } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { shortId: string; versionNumber: number };
}

/** Opens the review canvas and waits until the frame bridge is running. */
export async function openCanvas(page: Page, shortId: string, n?: number) {
  await page.goto(`/pages/${shortId}${n ? `?n=${n}` : ""}`);
  await expect(page.frameLocator("iframe").locator("body")).toBeVisible();
  await page.waitForTimeout(500);
}

/** Signs in with the dev sign-in (e2e server only) and creates a fresh page to review. */
export async function signInAndCreatePage(page: Page, html: string, title = `E2E ${Date.now()}`) {
  await signIn(page);
  const { shortId } = await createPage(page, html, title);
  await openCanvas(page, shortId);
  return shortId;
}

/** Places a pinned comment with the C shortcut on `selector` inside the frame and posts it. */
export async function pinComment(page: Page, selector: string, text: string, position?: { x: number; y: number }) {
  await page.locator('button[aria-keyshortcuts="C"]').click();
  await page.frameLocator("iframe").locator(selector).click(position ? { position, force: true } : undefined);
  const composer = page.getByRole("dialog", { name: "New comment" });
  await expect(composer).toBeVisible();
  await composer.getByRole("textbox", { name: "Comment" }).fill(text);
  await page.keyboard.press("Enter");
  await expect(composer).toBeHidden();
}

/**
 * Seeds a page owned by another member straight into the e2e database, so non-owner
 * flows can be tested with the single dev sign-in.
 */
export async function seedForeignPage(title: string, html: string) {
  const sql = postgres(E2E_DATABASE_URL, { max: 1 });
  try {
    await sql`insert into members (id, email, name) values ('e2e|other', 'other@draftpage.local', 'Other Reviewer')
              on conflict (id) do nothing`;
    const shortId = Math.random().toString(36).slice(2, 12).padEnd(10, "x");
    const [pageRow] = await sql`insert into pages (short_id, title, owner_member_id)
                                values (${shortId}, ${title}, 'e2e|other') returning id`;
    const [version] = await sql`insert into page_versions (page_id, number, html, origin, created_by_member_id)
              values (${pageRow!.id}, 1, ${html}, 'upload', 'e2e|other') returning id`;
    return { shortId, versionId: version!.id as string };
  } finally {
    await sql.end();
  }
}

/** Saves a screenshot for visual review when SHOTS=1 (kept in test-results/, gitignored). */
export async function shot(page: Page, name: string) {
  if (process.env.SHOTS) await page.screenshot({ path: `test-results/shots/${name}.png` });
}

export const SAMPLE_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:40px">
<h1>Hello</h1><p id="intro">This is a simple HTML page.</p><button>Click me</button>
<div style="height:600px"></div></body></html>`;

export const SAMPLE_HTML_V2 = `<!doctype html><html><body style="font-family:system-ui;padding:40px">
<h1>Hello again</h1><p id="intro">This is version two.</p><button>Click me</button>
<div style="height:600px"></div></body></html>`;
