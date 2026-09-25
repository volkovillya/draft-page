import { expect, test, type Page } from "@playwright/test";
import { SAMPLE_HTML, pinComment, shot, signInAndCreatePage } from "./helpers";

const rail = (page: Page) => page.getByRole("complementary", { name: "Comments" });
const card = (page: Page, n: number) => page.getByRole("dialog", { name: `Thread ${n}` });

test.describe("pinned comment threads", () => {
  test.beforeEach(async ({ page }) => {
    await signInAndCreatePage(page, SAMPLE_HTML);
  });

  test("the empty rail explains how to comment", async ({ page }) => {
    await expect(rail(page)).toContainText("No open comments");
    await shot(page, "10-canvas-empty");
  });

  test("a pinned comment gets a numbered marker, a rail entry and opens its card", async ({ page }) => {
    await pinComment(page, "h1", "Headline is too small");
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeVisible();
    await expect(rail(page)).toContainText("Headline is too small");
    await expect(card(page, 1)).toBeVisible(); // the new thread is selected
    await expect(page.getByRole("button", { name: "Hide comments, 1 open" })).toBeVisible();
    await shot(page, "11-thread-card");
  });

  test("markers and rail entries open the same card, and Close / Esc close it", async ({ page }) => {
    await pinComment(page, "h1", "first");
    await card(page, 1).getByRole("button", { name: "Close" }).click();
    await expect(card(page, 1)).toBeHidden();

    await page.getByRole("button", { name: "Thread 1, open" }).click();
    await expect(card(page, 1)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card(page, 1)).toBeHidden();

    await rail(page).getByRole("button", { name: /Thread 1/ }).click();
    await expect(card(page, 1)).toBeVisible();
    await page.frameLocator("iframe").locator("body").click({ position: { x: 600, y: 500 } });
    await expect(card(page, 1)).toBeHidden();
  });

  test("replies post with Enter, Shift+Enter adds a line", async ({ page }) => {
    await pinComment(page, "h1", "first");
    const reply = card(page, 1).getByRole("textbox", { name: "Reply" });
    await reply.fill("line one");
    await reply.press("Shift+Enter");
    await reply.pressSequentially("line two");
    await reply.press("Enter");
    await expect(card(page, 1)).toContainText("line one\nline two");
    await expect(reply).toHaveValue("");
    await expect(rail(page)).toContainText("1 reply");
  });

  test("resolve moves a thread to Resolved; reopen brings it back", async ({ page }) => {
    await pinComment(page, "h1", "fix me");
    await card(page, 1).getByRole("button", { name: "Resolve thread" }).click();
    await expect(page.getByRole("button", { name: "Thread 1, resolved" })).toBeVisible();
    await expect(card(page, 1)).toContainText("Resolved");
    await expect(card(page, 1).getByRole("textbox", { name: "Reply" })).toBeHidden();
    await expect(rail(page).getByRole("tab", { name: /Resolved/ })).toContainText("1");
    await rail(page).getByRole("tab", { name: /Resolved/ }).click();
    await expect(rail(page)).toContainText("fix me");
    await shot(page, "12-resolved");

    // Switching rail tabs doesn't count as clicking outside: the card stays open.
    await expect(card(page, 1)).toBeVisible();
    await card(page, 1).getByRole("button", { name: "Reopen thread" }).click();
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeVisible();
    await rail(page).getByRole("tab", { name: /Open/ }).click();
    await expect(rail(page)).toContainText("fix me");
  });

  test("deleting a reply keeps the thread; deleting the first message removes it", async ({ page }) => {
    await pinComment(page, "h1", "opening message");
    await card(page, 1).getByRole("textbox", { name: "Reply" }).fill("a reply");
    await page.keyboard.press("Enter");
    await expect(card(page, 1)).toContainText("a reply");

    await card(page, 1).getByText("a reply").hover();
    await card(page, 1).getByRole("button", { name: "Delete message" }).click();
    await expect(card(page, 1)).not.toContainText("a reply");

    page.once("dialog", (d) => void d.accept());
    await card(page, 1).getByText("opening message").hover();
    await card(page, 1).getByRole("button", { name: "Delete thread" }).click();
    await expect(card(page, 1)).toBeHidden();
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeHidden();
    await expect(rail(page)).toContainText("No open comments");
  });

  test("dismissing the delete-thread confirmation keeps it", async ({ page }) => {
    await pinComment(page, "h1", "stay");
    page.once("dialog", (d) => void d.dismiss());
    await card(page, 1).getByText("stay").hover();
    await card(page, 1).getByRole("button", { name: "Delete thread" }).click();
    await expect(card(page, 1)).toBeVisible();
  });

  test("threads are numbered oldest first and survive a reload", async ({ page }) => {
    await pinComment(page, "h1", "first one");
    await pinComment(page, "button", "second one");
    await page.reload();
    await expect(page.getByRole("button", { name: "Thread 1, open" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Thread 2, open" })).toBeVisible();
    const items = rail(page).getByRole("listitem");
    await expect(items.nth(0)).toContainText("first one");
    await expect(items.nth(1)).toContainText("second one");
  });

  test("markers follow the page when it scrolls", async ({ page }) => {
    await pinComment(page, "h1", "scroll with me");
    await card(page, 1).getByRole("button", { name: "Close" }).click();
    const marker = page.getByRole("button", { name: "Thread 1, open" });
    const before = (await marker.boundingBox())!;
    await page.frameLocator("iframe").locator("body").hover();
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(400);
    const after = await marker.boundingBox();
    // Either it moved up with the content, or it's hidden because it scrolled out of view.
    if (after) expect(after.y).toBeLessThan(before.y - 50);
  });

  test("comment text is shown as text, never as HTML", async ({ page }) => {
    await pinComment(page, "h1", '<img src=x onerror="document.title=\'pwned\'"><b>bold?</b>');
    await expect(card(page, 1)).toContainText("<b>bold?</b>");
    await expect(page).not.toHaveTitle("pwned");
  });

  test("an @Claude comment highlights the mention and is marked as sent", async ({ page }) => {
    await pinComment(page, "h1", "@Claude make the headline bigger");
    await expect(card(page, 1)).toContainText("Sent to Claude");
    await expect(card(page, 1).getByText("@Claude", { exact: true })).toBeVisible();
  });

  test("the composer's Send to Claude checkbox and the @Claude text stay in sync", async ({ page }) => {
    await page.locator('button[aria-keyshortcuts="C"]').click();
    await page.frameLocator("iframe").locator("h1").click();
    const composer = page.getByRole("dialog", { name: "New comment" });
    const box = composer.getByRole("textbox", { name: "Comment" });
    const check = composer.getByRole("checkbox", { name: "Send to Claude" });
    await box.fill("hello");
    await check.check();
    await expect(box).toHaveValue("@Claude hello");
    await check.uncheck();
    await expect(box).toHaveValue("hello");
    await box.fill("@claude do it");
    await expect(check).toBeChecked();
    await shot(page, "13-composer-claude");
  });

  test("an empty comment or one that is only @Claude cannot be posted", async ({ page }) => {
    await page.locator('button[aria-keyshortcuts="C"]').click();
    await page.frameLocator("iframe").locator("h1").click();
    const composer = page.getByRole("dialog", { name: "New comment" });
    await expect(composer.getByRole("button", { name: "Post comment" })).toBeDisabled();
    await composer.getByRole("textbox", { name: "Comment" }).fill("@Claude   ");
    await expect(composer.getByRole("button", { name: "Post comment" })).toBeDisabled();
  });

  test("the rail can be hidden and shown again", async ({ page }) => {
    await rail(page).getByRole("button", { name: "Hide comments" }).click();
    await expect(rail(page)).toBeHidden();
    await page.getByRole("button", { name: "Show comments, 0 open" }).click();
    await expect(rail(page)).toBeVisible();
  });

  test("the C shortcut toggles placing mode, and a second C turns it off", async ({ page }) => {
    const toggle = page.locator('button[aria-keyshortcuts="C"]');
    await page.keyboard.press("c");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Click anywhere to comment")).toBeVisible();
    await shot(page, "14-placing");
    await page.keyboard.press("c");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  test("typing c in a reply box doesn't toggle placing mode", async ({ page }) => {
    await pinComment(page, "h1", "first");
    await card(page, 1).getByRole("textbox", { name: "Reply" }).pressSequentially("cc");
    await expect(page.locator('button[aria-keyshortcuts="C"]')).toHaveAttribute("aria-pressed", "false");
    await expect(card(page, 1).getByRole("textbox", { name: "Reply" })).toHaveValue("cc");
  });

  test("two comments at the same spot merge into a cluster that cycles", async ({ page }) => {
    await pinComment(page, "h1", "one", { x: 20, y: 10 });
    await pinComment(page, "h1", "two", { x: 34, y: 14 });
    await card(page, 2).getByRole("button", { name: "Close" }).click();
    const cluster = page.getByRole("button", { name: /2 threads here/ });
    await expect(cluster).toBeVisible();
    await cluster.click();
    await expect(card(page, 1)).toBeVisible();
    await cluster.click();
    await expect(card(page, 2)).toBeVisible();
  });

  test("a pin sits beside the point it marks instead of covering it", async ({ page }) => {
    await page.locator('button[aria-keyshortcuts="C"]').click();
    const frameBox = (await page.locator("iframe").boundingBox())!;
    const h1 = (await page.frameLocator("iframe").locator("h1").boundingBox())!;
    const point = { x: h1.x + 20, y: h1.y + h1.height / 2 };
    await page.mouse.click(point.x, point.y);
    await page.getByRole("dialog", { name: "New comment" }).getByRole("textbox", { name: "Comment" }).fill("pin");
    await page.keyboard.press("Enter");
    const pin = (await page.getByRole("button", { name: "Thread 1, open" }).boundingBox())!;
    expect(frameBox).toBeTruthy();
    // Its bottom-left corner is the point (ring and rounding allow a few px).
    expect(Math.abs(pin.x - point.x)).toBeLessThanOrEqual(4);
    expect(Math.abs(pin.y + pin.height - point.y)).toBeLessThanOrEqual(4);
    // The card opens beside the pin, not over it.
    const cardBox = (await card(page, 1).boundingBox())!;
    expect(cardBox.x).toBeGreaterThanOrEqual(pin.x + pin.width);
  });
});

test.describe("pins on empty space", () => {
  const CENTRED = `<!doctype html><html><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f4f4">
    <div id="card" style="width:300px;height:160px;background:#fff">Card</div></body></html>`;

  test("attach to the nearest element and follow it when the layout reflows", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAndCreatePage(page, CENTRED);
    await rail(page).getByRole("button", { name: "Hide comments" }).click();
    const cardEl = page.frameLocator("iframe").locator("#card");
    const before = (await cardEl.boundingBox())!;
    // 60px to the right of the card, on the empty background.
    await page.locator('button[aria-keyshortcuts="C"]').click();
    await page.mouse.click(before.x + before.width + 60, before.y + 80);
    const composer = page.getByRole("dialog", { name: "New comment" });
    await expect(composer).toContainText("div"); // attached to an element, not the page body
    await composer.getByRole("textbox", { name: "Comment" }).fill("too much space here");
    await page.keyboard.press("Enter");
    await card(page, 1).getByRole("button", { name: "Close" }).click();
    const pin = page.getByRole("button", { name: "Thread 1, open" });
    const p1 = (await pin.boundingBox())!;
    const offset1 = p1.x - (before.x + before.width);

    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(600);
    const after = (await cardEl.boundingBox())!;
    expect(after.x).not.toBeCloseTo(before.x, 0); // the card really moved
    const p2 = (await pin.boundingBox())!;
    expect(Math.abs(p2.x - (after.x + after.width) - offset1)).toBeLessThanOrEqual(3);
  });
});

test.describe("the frame handshake", () => {
  test("comment mode works on every fresh load", async ({ page }) => {
    const shortId = await signInAndCreatePage(page, SAMPLE_HTML);
    for (let i = 0; i < 10; i++) {
      await page.goto(`/pages/${shortId}`);
      await expect(page.frameLocator("iframe").locator("h1")).toBeVisible();
      await page.locator('button[aria-keyshortcuts="C"]').click();
      await expect(page.frameLocator("iframe").locator("html[data-dp-placing]")).toHaveCount(1, { timeout: 3000 });
    }
  });
});

