import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_HTML_BYTES } from "@/server/core/guards";
import { countPages, createPage, defaultVersion, deletePage, getPage, listPages } from "@/server/core/pages";
import { closeThread, openThread, postMessage } from "@/server/core/threads";
import { addVersion, publishVersion } from "@/server/core/versions";
import { messages, pages, pageVersions, threads } from "@/server/db/tables";
import { assistantActor, closeTestDb, failureCode, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();
const HTML = "<html><body><p>Hi</p></body></html>";

beforeEach(reset);
afterAll(closeTestDb);

describe("createPage", () => {
  it("creates the page with a v1 draft upload", async () => {
    const owner = await makeMember();
    const created = await createPage(db, owner, { title: "  My page  ", html: HTML });
    expect(created.versionNumber).toBe(1);
    expect(created.shortId).toMatch(/^[a-z0-9]{10}$/);

    const page = await db.query.pages.findFirst({ where: eq(pages.shortId, created.shortId) });
    expect(page).toMatchObject({ title: "My page", ownerMemberId: owner.memberId });
    const versions = await db.select().from(pageVersions).where(eq(pageVersions.pageId, page!.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      id: created.versionId,
      number: 1,
      state: "draft",
      origin: "upload",
      html: HTML,
      createdByMemberId: owner.memberId,
    });
  });

  it("validates the title bounds", async () => {
    const owner = await makeMember();
    expect(await failureCode(createPage(db, owner, { title: "", html: HTML }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: "   ", html: HTML }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: 42, html: HTML }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: "x".repeat(201), html: HTML }))).toBe("invalid");
    await expect(createPage(db, owner, { title: "x".repeat(200), html: HTML })).resolves.toBeDefined();
    await expect(createPage(db, owner, { title: "x", html: HTML })).resolves.toBeDefined();
  });

  it("rejects empty, non-string or oversized HTML", async () => {
    const owner = await makeMember();
    expect(await failureCode(createPage(db, owner, { title: "T", html: "" }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: "T", html: "  \n " }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: "T", html: undefined }))).toBe("invalid");
    expect(await failureCode(createPage(db, owner, { title: "T", html: "a".repeat(MAX_HTML_BYTES + 1) }))).toBe(
      "invalid",
    );
    // Bytes, not characters: 1 Mi of 3-byte characters is over the limit.
    expect(await failureCode(createPage(db, owner, { title: "T", html: "€".repeat(1024 * 1024) }))).toBe("invalid");
    await expect(createPage(db, owner, { title: "T", html: "a".repeat(MAX_HTML_BYTES) })).resolves.toBeDefined();
    expect(await db.select().from(pages)).toHaveLength(1);
  });

  it("refuses the assistant", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const bot = assistantActor({ pageId: page.id });
    expect(await failureCode(createPage(db, bot, { title: "T", html: HTML }))).toBe("not_allowed");
    expect(await db.select().from(pages)).toHaveLength(1);
  });
});

describe("listPages", () => {
  it("puts my pages first and reports version, live and open-thread counts", async () => {
    const me = await makeMember({ name: "Me" });
    const other = await makeMember({ name: "Other" });

    const mine = await makePage(me, HTML, "Mine");
    const v2 = await addVersion(db, me, { shortId: mine.shortId, html: HTML });
    await addVersion(db, me, { shortId: mine.shortId, html: HTML });
    await publishVersion(db, me, v2.versionId);
    const detail = await getPage(db, me, mine.shortId);
    const newest = detail.versions[0]!.id;
    await openThread(db, other, { versionId: newest, posX: 0.1, posY: 0.1, text: "one" });
    const t2 = await openThread(db, other, { versionId: newest, posX: 0.2, posY: 0.2, text: "two" });
    await openThread(db, me, { versionId: newest, posX: 0.3, posY: 0.3, text: "three" });
    await closeThread(db, other, t2.threadId);

    // Created after mine, so it's newer; it must still come second.
    const theirs = await makePage(other, HTML, "Theirs");

    const list = await listPages(db, me);
    expect(list.map((p) => p.title)).toEqual(["Mine", "Theirs"]);
    expect(list[0]).toMatchObject({
      shortId: mine.shortId,
      isMine: true,
      ownerName: "Me",
      versionCount: 3,
      latestNumber: 3,
      liveNumber: 2,
      openThreads: 2,
    });
    expect(list[1]).toMatchObject({
      shortId: theirs.shortId,
      isMine: false,
      ownerName: "Other",
      versionCount: 1,
      latestNumber: 1,
      liveNumber: null,
      openThreads: 0,
    });

    const fromOther = await listPages(db, other);
    expect(fromOther.map((p) => p.title)).toEqual(["Theirs", "Mine"]);
  });

  it("orders each group newest first", async () => {
    const me = await makeMember();
    const a = await makePage(me, HTML, "A");
    await makePage(me, HTML, "B");
    await addVersion(db, me, { shortId: a.shortId, html: HTML }); // touches A
    expect((await listPages(db, me)).map((p) => p.title)).toEqual(["A", "B"]);
  });

  it("pages with limit/offset in the same order, and counts mine vs shared", async () => {
    const me = await makeMember();
    const other = await makeMember();
    await makePage(other, HTML, "T1");
    await makePage(me, HTML, "M1");
    await makePage(other, HTML, "T2");
    await makePage(me, HTML, "M2");
    const all = (await listPages(db, me)).map((p) => p.title);
    expect(all).toEqual(["M2", "M1", "T2", "T1"]);
    const first = (await listPages(db, me, { limit: 3 })).map((p) => p.title);
    const rest = (await listPages(db, me, { limit: 3, offset: 3 })).map((p) => p.title);
    expect([...first, ...rest]).toEqual(all);
    expect(await countPages(db, me)).toEqual({ mine: 2, shared: 2 });
  });

  it("refuses the assistant", async () => {
    expect(await failureCode(listPages(db, assistantActor()))).toBe("not_allowed");
    expect(await failureCode(countPages(db, assistantActor()))).toBe("not_allowed");
  });
});

describe("getPage", () => {
  it("returns the page with versions newest first", async () => {
    const owner = await makeMember({ name: "Owner" });
    const viewer = await makeMember();
    const page = await makePage(owner);
    await addVersion(db, owner, { shortId: page.shortId, html: HTML });

    const asOwner = await getPage(db, owner, page.shortId);
    expect(asOwner).toMatchObject({ id: page.id, shortId: page.shortId, ownerName: "Owner", isOwner: true });
    expect(asOwner.versions.map((v) => v.number)).toEqual([2, 1]);
    expect(defaultVersion(asOwner).number).toBe(2);

    await publishVersion(db, owner, page.versionId);
    const asViewer = await getPage(db, viewer, page.shortId);
    expect(asViewer.isOwner).toBe(false);
    expect(defaultVersion(asViewer).number).toBe(1);
  });

  it("is missing for an unknown shortId", async () => {
    const member = await makeMember();
    expect(await failureCode(getPage(db, member, "nosuchpage"))).toBe("missing");
  });
});

describe("deletePage", () => {
  it("only the owner can delete", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const page = await makePage(owner);
    expect(await failureCode(deletePage(db, other, page.shortId))).toBe("not_allowed");
    expect(await db.select().from(pages)).toHaveLength(1);
  });

  it("is missing for an unknown page", async () => {
    const owner = await makeMember();
    expect(await failureCode(deletePage(db, owner, "nosuchpage"))).toBe("missing");
  });

  it("cascades to versions, threads and messages", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const page = await makePage(owner);
    const keep = await makePage(other);
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: HTML });
    const t = await openThread(db, other, { versionId: v2.versionId, posX: 0.5, posY: 0.5, text: "hello" });
    await postMessage(db, owner, { threadId: t.threadId, text: "reply" });
    await openThread(db, owner, { versionId: keep.versionId, posX: 0.5, posY: 0.5, text: "kept" });

    await deletePage(db, owner, page.shortId);

    expect(await db.select().from(pages).where(eq(pages.id, page.id))).toHaveLength(0);
    expect(await db.select().from(pageVersions).where(eq(pageVersions.pageId, page.id))).toHaveLength(0);
    expect(await db.select().from(threads).where(eq(threads.pageId, page.id))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.threadId, t.threadId))).toHaveLength(0);
    // The other page is untouched.
    expect(await db.select().from(pageVersions)).toHaveLength(1);
    expect(await db.select().from(threads)).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
  });

  it("refuses the assistant, even for its own page", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const bot = assistantActor({ pageId: page.id });
    expect(await failureCode(deletePage(db, bot, page.shortId))).toBe("not_allowed");
    expect(await db.select().from(pages)).toHaveLength(1);
  });
});
