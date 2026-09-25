import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openThread } from "@/server/core/threads";
import { addVersion, deleteVersion, getVersionHtml, publishVersion, unpublishVersion } from "@/server/core/versions";
import { threads } from "@/server/db/tables";
import { pageVersions } from "@/server/db/tables";
import { assistantActor, closeTestDb, failureCode, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();
const HTML = "<html><body>v</body></html>";

beforeEach(reset);
afterAll(closeTestDb);

async function states(pageId: string) {
  const rows = await db
    .select({ number: pageVersions.number, state: pageVersions.state })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(pageVersions.number);
  return rows.map((r) => `${r.number}:${r.state}`);
}

describe("addVersion", () => {
  it("lets the owner add a draft upload with the next number", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>two</p>" });
    expect(v2.number).toBe(2);
    const row = await db.query.pageVersions.findFirst({ where: eq(pageVersions.id, v2.versionId) });
    expect(row).toMatchObject({ state: "draft", origin: "upload", createdByMemberId: owner.memberId, html: "<p>two</p>" });
  });

  it("refuses anyone but the owner", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const page = await makePage(owner);
    expect(await failureCode(addVersion(db, other, { shortId: page.shortId, html: HTML }))).toBe("not_allowed");
    expect(await failureCode(addVersion(db, other, { pageId: page.id, html: HTML }))).toBe("not_allowed");
    expect(await states(page.id)).toEqual(["1:draft"]);
  });

  it("validates the HTML and the page", async () => {
    const owner = await makeMember();
    expect(await failureCode(addVersion(db, owner, { shortId: "nosuchpage", html: HTML }))).toBe("missing");
    expect(await failureCode(addVersion(db, owner, { pageId: "not-a-uuid", html: HTML }))).toBe("invalid");
    const page = await makePage(owner);
    expect(await failureCode(addVersion(db, owner, { shortId: page.shortId, html: "" }))).toBe("invalid");
  });

  it("allocates 2..11 with no gaps or duplicates under 10 concurrent calls", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => addVersion(db, owner, { shortId: page.shortId, html: `<p>${i}</p>` })),
    );
    expect(results.map((r) => r.number).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const rows = await db.select({ n: pageVersions.number }).from(pageVersions).where(eq(pageVersions.pageId, page.id));
    expect(rows.map((r) => r.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("lets the assistant add a draft to its own page only", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const otherPage = await makePage(owner);
    const bot = assistantActor({ pageId: page.id });

    const added = await addVersion(db, bot, { pageId: page.id, html: HTML, basedOnVersionId: page.versionId });
    expect(added.number).toBe(2);
    const row = await db.query.pageVersions.findFirst({ where: eq(pageVersions.id, added.versionId) });
    expect(row).toMatchObject({
      state: "draft",
      origin: "assistant",
      createdByMemberId: null,
      basedOnVersionId: page.versionId,
    });

    expect(await failureCode(addVersion(db, bot, { pageId: otherPage.id, html: HTML }))).toBe("not_allowed");
    expect(await failureCode(addVersion(db, bot, { shortId: otherPage.shortId, html: HTML }))).toBe("not_allowed");
    expect(await states(otherPage.id)).toEqual(["1:draft"]);
  });

  it("rejects a base version from another page", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const otherPage = await makePage(owner);
    const attempt = addVersion(db, owner, { pageId: page.id, html: HTML, basedOnVersionId: otherPage.versionId });
    expect(await failureCode(attempt)).toBe("invalid");
    expect(await states(page.id)).toEqual(["1:draft"]);
  });
});

describe("publishVersion / unpublishVersion", () => {
  it("publishing demotes the previous live version, leaving exactly one live", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: HTML });
    const v3 = await addVersion(db, owner, { shortId: page.shortId, html: HTML });

    await publishVersion(db, owner, page.versionId);
    expect(await states(page.id)).toEqual(["1:live", "2:draft", "3:draft"]);
    await publishVersion(db, owner, v3.versionId);
    expect(await states(page.id)).toEqual(["1:draft", "2:draft", "3:live"]);
    await publishVersion(db, owner, v2.versionId);
    expect(await states(page.id)).toEqual(["1:draft", "2:live", "3:draft"]);
    // Publishing the live one again is a no-op.
    await publishVersion(db, owner, v2.versionId);
    expect(await states(page.id)).toEqual(["1:draft", "2:live", "3:draft"]);

    const live = await db.query.pageVersions.findFirst({ where: eq(pageVersions.id, v2.versionId) });
    expect(live!.madeLiveByMemberId).toBe(owner.memberId);
    expect(live!.madeLiveAt).toBeInstanceOf(Date);
  });

  it("concurrent publishes still leave exactly one live version", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const ids = [page.versionId];
    for (let i = 0; i < 4; i++) ids.push((await addVersion(db, owner, { shortId: page.shortId, html: HTML })).versionId);
    await Promise.all(ids.map((id) => publishVersion(db, owner, id)));
    const live = (await states(page.id)).filter((s) => s.endsWith(":live"));
    expect(live).toHaveLength(1);
  });

  it("unpublish returns the version to draft", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    await publishVersion(db, owner, page.versionId);
    await unpublishVersion(db, owner, page.versionId);
    expect(await states(page.id)).toEqual(["1:draft"]);
  });

  it("refuses non-owners", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const page = await makePage(owner);
    expect(await failureCode(publishVersion(db, other, page.versionId))).toBe("not_allowed");
    await publishVersion(db, owner, page.versionId);
    expect(await failureCode(unpublishVersion(db, other, page.versionId))).toBe("not_allowed");
    expect(await states(page.id)).toEqual(["1:live"]);
  });

  it("refuses the assistant even with a valid version id of its own page", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const bot = assistantActor({ pageId: page.id });
    const added = await addVersion(db, bot, { pageId: page.id, html: HTML });
    expect(await failureCode(publishVersion(db, bot, added.versionId))).toBe("not_allowed");
    expect(await failureCode(publishVersion(db, bot, page.versionId))).toBe("not_allowed");
    expect(await failureCode(unpublishVersion(db, bot, page.versionId))).toBe("not_allowed");
    expect(await states(page.id)).toEqual(["1:draft", "2:draft"]);
  });

  it("reports missing and invalid ids", async () => {
    const owner = await makeMember();
    expect(await failureCode(publishVersion(db, owner, "nope"))).toBe("invalid");
    expect(await failureCode(publishVersion(db, owner, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
  });
});

describe("one live version is enforced by the database", () => {
  it("rejects a raw update that would make a second version live", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: HTML });
    await publishVersion(db, owner, page.versionId);

    await expect(
      db.execute(sql`update page_versions set state = 'live' where id = ${v2.versionId}`),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint_name: "page_versions_one_live_uq" } });
    expect(await states(page.id)).toEqual(["1:live", "2:draft"]);
  });

  it("rejects a raw insert of a second live version", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    await publishVersion(db, owner, page.versionId);

    await expect(
      db.execute(
        sql`insert into page_versions (page_id, number, html, state, origin, created_by_member_id)
            values (${page.id}, 2, 'x', 'live', 'upload', ${owner.memberId})`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint_name: "page_versions_one_live_uq" } });
    expect(await states(page.id)).toEqual(["1:live"]);
  });

  it("allows live versions on different pages", async () => {
    const owner = await makeMember();
    const a = await makePage(owner);
    const b = await makePage(owner);
    await publishVersion(db, owner, a.versionId);
    await publishVersion(db, owner, b.versionId);
    const live = await db.select().from(pageVersions).where(and(eq(pageVersions.state, "live")));
    expect(live).toHaveLength(2);
  });
});

describe("getVersionHtml", () => {
  it("returns the HTML to members", async () => {
    const owner = await makeMember();
    const viewer = await makeMember();
    const page = await makePage(owner, "<p>content</p>");
    expect(await getVersionHtml(db, viewer, page.versionId)).toEqual({ html: "<p>content</p>", pageId: page.id, number: 1 });
  });

  it("scopes the assistant to its own page", async () => {
    const owner = await makeMember();
    const page = await makePage(owner, "<p>mine</p>");
    const other = await makePage(owner, "<p>other</p>");
    const bot = assistantActor({ pageId: page.id });
    expect((await getVersionHtml(db, bot, page.versionId)).html).toBe("<p>mine</p>");
    expect(await failureCode(getVersionHtml(db, bot, other.versionId))).toBe("not_allowed");
  });

  it("reports missing and invalid ids", async () => {
    const owner = await makeMember();
    expect(await failureCode(getVersionHtml(db, owner, "x"))).toBe("invalid");
    expect(await failureCode(getVersionHtml(db, owner, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
  });
});

describe("deleteVersion", () => {
  it("deletes one draft; the others keep their numbers", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const v2 = await addVersion(db, owner, { pageId: page.id, html: "<p>2</p>" });
    await addVersion(db, owner, { pageId: page.id, html: "<p>3</p>" });
    await deleteVersion(db, owner, v2.versionId);
    expect(await states(page.id)).toEqual(["1:draft", "3:draft"]);
  });

  it("deletes the threads opened on it, and keeps threads carried from earlier versions", async () => {
    const owner = await makeMember();
    const page = await makePage(owner);
    const onV1 = await openThread(db, owner, { versionId: page.versionId, posX: 0.1, posY: 0.1, text: "on v1" });
    const v2 = await addVersion(db, owner, { pageId: page.id, html: "<p>2</p>" });
    const onV2 = await openThread(db, owner, { versionId: v2.versionId, posX: 0.1, posY: 0.1, text: "@Claude on v2" });
    await deleteVersion(db, owner, v2.versionId);
    const left = await db.select({ id: threads.id }).from(threads);
    expect(left.map((t) => t.id)).toEqual([onV1.threadId]);
    expect(left.map((t) => t.id)).not.toContain(onV2.threadId);
  });

  it("refuses the live version, the last version, non-owners and the assistant", async () => {
    const owner = await makeMember();
    const other = await makeMember();
    const page = await makePage(owner);
    expect(await failureCode(deleteVersion(db, owner, page.versionId))).toBe("invalid"); // the only one
    const v2 = await addVersion(db, owner, { pageId: page.id, html: "<p>2</p>" });
    await publishVersion(db, owner, v2.versionId);
    expect(await failureCode(deleteVersion(db, owner, v2.versionId))).toBe("invalid"); // live
    expect(await failureCode(deleteVersion(db, other, page.versionId))).toBe("not_allowed");
    expect(await failureCode(deleteVersion(db, assistantActor({ pageId: page.id }), page.versionId))).toBe("not_allowed");
    expect(await failureCode(deleteVersion(db, owner, "nope"))).toBe("invalid");
    expect(await states(page.id)).toEqual(["1:draft", "2:live"]);
  });
});
