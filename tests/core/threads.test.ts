import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MemberActor } from "@/server/core/actor";
import {
  closeThread,
  deleteMessage,
  listThreads,
  openThread,
  postMessage,
  reopenThread,
  type OpenThreadInput,
} from "@/server/core/threads";
import { addVersion } from "@/server/core/versions";
import { messages, threads } from "@/server/db/tables";
import {
  assistantActor,
  closeTestDb,
  failureCode,
  makeMember,
  makePage,
  reset,
  testDb,
  type MadePage,
} from "../helpers/db";

const db = testDb();

beforeEach(reset);
afterAll(closeTestDb);

async function setup() {
  const owner = await makeMember({ name: "Owner" });
  const reviewer = await makeMember({ name: "Reviewer" });
  const bystander = await makeMember({ name: "Bystander" });
  const page = await makePage(owner);
  return { owner, reviewer, bystander, page };
}

function open(actor: MemberActor, page: MadePage | { versionId: string }, extra: Partial<OpenThreadInput> = {}) {
  return openThread(db, actor, { versionId: page.versionId, posX: 0.25, posY: 0.75, text: "Looks off", ...extra });
}

async function threadRow(id: string) {
  return (await db.query.threads.findFirst({ where: eq(threads.id, id) }))!;
}

async function messageRows(threadId: string) {
  return db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(messages.seq);
}

describe("openThread", () => {
  it("creates the thread and its seq-1 message together", async () => {
    const { reviewer, page } = await setup();
    const { threadId, claudeRequested } = await open(reviewer, page, {
      targetPath: "body > h1:nth-of-type(1)",
      excerpt: "Hello",
      text: "  Rename this  ",
    });
    expect(claudeRequested).toBe(false);
    expect(await threadRow(threadId)).toMatchObject({
      pageId: page.id,
      openedOnVersionId: page.versionId,
      posX: 0.25,
      posY: 0.75,
      targetPath: "body > h1:nth-of-type(1)",
      excerpt: "Hello",
      claudeRequestedAt: null,
      closedAt: null,
    });
    const msgs = await messageRows(threadId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ seq: 1, authorKind: "member", authorMemberId: reviewer.memberId, text: "Rename this" });
  });

  it("is atomic: the thread is rolled back when the opening message insert fails", async () => {
    const { page } = await setup();
    // No members row for this actor: the thread insert succeeds, then the message's
    // author foreign key fails inside the same transaction.
    const ghost: MemberActor = { kind: "member", memberId: "auth0|ghost", email: "g@example.com", name: "Ghost" };
    await expect(open(ghost, page)).rejects.toMatchObject({ cause: { code: "23503" } });
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("stores nothing when the opening message is invalid", async () => {
    const { reviewer, page } = await setup();
    expect(await failureCode(open(reviewer, page, { text: "x".repeat(10_001) }))).toBe("invalid");
    expect(await failureCode(open(reviewer, page, { text: "   " }))).toBe("invalid");
    expect(await db.select().from(threads)).toHaveLength(0);
    expect(await db.select().from(messages)).toHaveLength(0);
  });

  it("only works on the newest version", async () => {
    const { owner, reviewer, page } = await setup();
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>2</p>" });
    expect(await failureCode(open(reviewer, page))).toBe("invalid");
    await expect(open(reviewer, { versionId: v2.versionId })).resolves.toBeDefined();
    expect(await db.select().from(threads)).toHaveLength(1);
  });

  it("reports an unknown or malformed version", async () => {
    const { reviewer } = await setup();
    expect(await failureCode(open(reviewer, { versionId: "00000000-0000-4000-8000-000000000000" }))).toBe("missing");
    expect(await failureCode(open(reviewer, { versionId: "bad" }))).toBe("invalid");
  });

  it("requires positions between -1 and 2 (up to one box outside the target)", async () => {
    const { reviewer, page } = await setup();
    for (const bad of [-1.01, 2.01, Number.NaN, Number.POSITIVE_INFINITY, "0.5", null, undefined]) {
      expect(await failureCode(open(reviewer, page, { posX: bad }))).toBe("invalid");
      expect(await failureCode(open(reviewer, page, { posY: bad }))).toBe("invalid");
    }
    await expect(open(reviewer, page, { posX: 0, posY: 1 })).resolves.toBeDefined();
    await expect(open(reviewer, page, { posX: -1, posY: 2 })).resolves.toBeDefined();
    await expect(open(reviewer, page, { posX: 1.5, posY: -0.5 })).resolves.toBeDefined();
  });

  it("truncates the excerpt to 500 characters", async () => {
    const { reviewer, page } = await setup();
    const { threadId } = await open(reviewer, page, { excerpt: "e".repeat(800) });
    expect((await threadRow(threadId)).excerpt).toBe("e".repeat(500));
  });

  it("rejects a target path over 512 characters", async () => {
    const { reviewer, page } = await setup();
    expect(await failureCode(open(reviewer, page, { targetPath: "a".repeat(513) }))).toBe("invalid");
  });

  it("refuses the assistant", async () => {
    const { page } = await setup();
    const bot = assistantActor({ pageId: page.id });
    expect(
      await failureCode(openThread(db, bot, { versionId: page.versionId, posX: 0, posY: 0, text: "hi" })),
    ).toBe("not_allowed");
  });
});

describe("@Claude requests", () => {
  async function requested(text: string) {
    const { reviewer, page } = await setup();
    const result = await open(reviewer, page, { text });
    const row = await threadRow(result.threadId);
    expect(result.claudeRequested).toBe(row.claudeRequestedAt !== null);
    return result.claudeRequested;
  }

  it("a leading @Claude with an instruction sets claudeRequestedAt", async () => {
    expect(await requested("@Claude make the header blue")).toBe(true);
  });

  it("is case-insensitive and tolerates leading whitespace", async () => {
    expect(await requested("  @claude fix typo")).toBe(true);
    expect(await requested("@CLAUDE: fix typo")).toBe(true);
  });

  it("isn't requested without an instruction", async () => {
    expect(await requested("@Claude")).toBe(false);
    expect(await requested("@claude   ")).toBe(false);
  });

  it("refuses an instruction over 4000 characters instead of quietly dropping the request", async () => {
    const { reviewer, page } = await setup();
    const tooLong = open(reviewer, page, { text: `@Claude ${"x".repeat(4001)}` });
    await expect(tooLong).rejects.toThrow("Instructions for Claude are limited to 4,000 characters");
    expect(await requested(`@Claude ${"x".repeat(4000)}`)).toBe(true);
    // Without the mention, a long message is just a comment.
    expect(await requested("x".repeat(4001))).toBe(false);
  });

  it("isn't requested by a mid-text mention", async () => {
    expect(await requested("Hey @Claude fix this")).toBe(false);
  });

  it("isn't requested by a longer handle", async () => {
    expect(await requested("@claudette fix this")).toBe(false);
  });

  it("a reply that mentions @Claude changes nothing", async () => {
    const { reviewer, owner, page } = await setup();
    const { threadId } = await open(reviewer, page, { text: "Plain comment" });
    await postMessage(db, owner, { threadId, text: "@Claude please fix it" });
    expect((await threadRow(threadId)).claudeRequestedAt).toBeNull();
  });

  it("the client can't force the flag with extra properties", async () => {
    const { reviewer, page } = await setup();
    const body = {
      versionId: page.versionId,
      posX: 0.5,
      posY: 0.5,
      text: "No mention here",
      claudeRequestedAt: new Date(),
      claudeRequested: true,
      claude_requested_at: "2026-01-01T00:00:00Z",
    };
    const result = await openThread(db, reviewer, body);
    expect(result.claudeRequested).toBe(false);
    expect((await threadRow(result.threadId)).claudeRequestedAt).toBeNull();
  });
});

describe("postMessage", () => {
  it("appends messages with increasing seq", async () => {
    const { reviewer, owner, page } = await setup();
    const { threadId } = await open(reviewer, page);
    expect((await postMessage(db, owner, { threadId, text: "two" })).seq).toBe(2);
    expect((await postMessage(db, reviewer, { threadId, text: "three" })).seq).toBe(3);
  });

  it("allocates distinct seqs under concurrency", async () => {
    const { reviewer, owner, bystander, page } = await setup();
    const { threadId } = await open(reviewer, page);
    const actors = [owner, reviewer, bystander, owner, reviewer];
    const results = await Promise.all(actors.map((a, i) => postMessage(db, a, { threadId, text: `m${i}` })));
    expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6]);
    expect((await messageRows(threadId)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses replies on a closed thread", async () => {
    const { reviewer, owner, page } = await setup();
    const { threadId } = await open(reviewer, page);
    await closeThread(db, reviewer, threadId);
    expect(await failureCode(postMessage(db, owner, { threadId, text: "late" }))).toBe("invalid");
    await reopenThread(db, reviewer, threadId);
    await expect(postMessage(db, owner, { threadId, text: "now ok" })).resolves.toMatchObject({ seq: 2 });
  });

  it("validates text and thread", async () => {
    const { reviewer, page } = await setup();
    const { threadId } = await open(reviewer, page);
    expect(await failureCode(postMessage(db, reviewer, { threadId, text: "" }))).toBe("invalid");
    expect(await failureCode(postMessage(db, reviewer, { threadId, text: "x".repeat(10_001) }))).toBe("invalid");
    expect(
      await failureCode(postMessage(db, reviewer, { threadId: "00000000-0000-4000-8000-000000000000", text: "x" })),
    ).toBe("missing");
  });

  it("the assistant may post only in its own thread, shown as Claude", async () => {
    const { reviewer, page } = await setup();
    const mine = await open(reviewer, page, { text: "@Claude tweak it" });
    const other = await open(reviewer, page);
    const bot = assistantActor({ pageId: page.id, threadId: mine.threadId });

    const posted = await postMessage(db, bot, { threadId: mine.threadId, text: "Done, see v2" });
    expect(posted.seq).toBe(2);
    expect(await failureCode(postMessage(db, bot, { threadId: other.threadId, text: "sneaky" }))).toBe("not_allowed");
    expect(await messageRows(other.threadId)).toHaveLength(1);

    const row = (await messageRows(mine.threadId))[1]!;
    expect(row).toMatchObject({ authorKind: "assistant", authorMemberId: null });

    const view = (await listThreads(db, reviewer, page.versionId)).find((t) => t.id === mine.threadId)!;
    expect(view.messages[1]).toMatchObject({ authorKind: "assistant", senderName: "Claude", text: "Done, see v2" });
    // "Claude · via <who asked>": the assistant answers the thread's opener; members have no via.
    expect(view.messages[1]!.via).toBe(view.messages[0]!.senderName);
    expect(view.messages[0]!.via).toBeNull();
    expect(view.messages[0]!.senderName).toBe("Reviewer");
  });
});

describe("closeThread / reopenThread", () => {
  it("the opener can close and reopen", async () => {
    const { reviewer, page } = await setup();
    const { threadId } = await open(reviewer, page);
    await closeThread(db, reviewer, threadId);
    const closed = await threadRow(threadId);
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(closed.closedByMemberId).toBe(reviewer.memberId);
    await reopenThread(db, reviewer, threadId);
    expect(await threadRow(threadId)).toMatchObject({ closedAt: null, closedByMemberId: null });
  });

  it("the page owner can close and reopen someone else's thread", async () => {
    const { reviewer, owner, page } = await setup();
    const { threadId } = await open(reviewer, page);
    await closeThread(db, owner, threadId);
    expect((await threadRow(threadId)).closedByMemberId).toBe(owner.memberId);
    await reopenThread(db, owner, threadId);
    expect((await threadRow(threadId)).closedAt).toBeNull();
  });

  it("others can't, not even people who replied", async () => {
    const { reviewer, bystander, page } = await setup();
    const { threadId } = await open(reviewer, page);
    await postMessage(db, bystander, { threadId, text: "me too" });
    expect(await failureCode(closeThread(db, bystander, threadId))).toBe("not_allowed");
    await closeThread(db, reviewer, threadId);
    expect(await failureCode(reopenThread(db, bystander, threadId))).toBe("not_allowed");
    expect((await threadRow(threadId)).closedAt).not.toBeNull();
  });

  it("the assistant can't close or reopen, even its own thread", async () => {
    const { reviewer, page } = await setup();
    const { threadId } = await open(reviewer, page, { text: "@Claude do it" });
    const bot = assistantActor({ pageId: page.id, threadId });
    expect(await failureCode(closeThread(db, bot, threadId))).toBe("not_allowed");
    expect((await threadRow(threadId)).closedAt).toBeNull();
    await closeThread(db, reviewer, threadId);
    expect(await failureCode(reopenThread(db, bot, threadId))).toBe("not_allowed");
  });

  it("reports an unknown thread", async () => {
    const { reviewer } = await setup();
    expect(await failureCode(closeThread(db, reviewer, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
    expect(await failureCode(closeThread(db, reviewer, "nope"))).toBe("invalid");
  });
});

describe("deleteMessage", () => {
  async function threadWithReply() {
    const ctx = await setup();
    const { threadId } = await open(ctx.reviewer, ctx.page);
    const reply = await postMessage(db, ctx.bystander, { threadId, text: "reply" });
    const opening = (await messageRows(threadId))[0]!;
    return { ...ctx, threadId, replyId: reply.messageId, openingId: opening.id };
  }

  it("the author can delete their reply", async () => {
    const { bystander, threadId, replyId } = await threadWithReply();
    await deleteMessage(db, bystander, replyId);
    expect((await messageRows(threadId)).map((m) => m.seq)).toEqual([1]);
  });

  it("the page owner can delete anyone's reply", async () => {
    const { owner, threadId, replyId } = await threadWithReply();
    await deleteMessage(db, owner, replyId);
    expect(await messageRows(threadId)).toHaveLength(1);
  });

  it("others can't, including the thread's opener", async () => {
    const { reviewer, threadId, replyId } = await threadWithReply();
    const stranger = await makeMember();
    expect(await failureCode(deleteMessage(db, stranger, replyId))).toBe("not_allowed");
    expect(await failureCode(deleteMessage(db, reviewer, replyId))).toBe("not_allowed");
    expect(await messageRows(threadId)).toHaveLength(2);
  });

  it("deleting seq 1 deletes the whole thread", async () => {
    const { reviewer, threadId, openingId } = await threadWithReply();
    await deleteMessage(db, reviewer, openingId);
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(0);
    expect(await messageRows(threadId)).toHaveLength(0);
  });

  it("the owner can delete the opening message too", async () => {
    const { owner, threadId, openingId } = await threadWithReply();
    await deleteMessage(db, owner, openingId);
    expect(await db.select().from(threads).where(eq(threads.id, threadId))).toHaveLength(0);
  });

  it("the assistant can't delete, and a missing message is reported", async () => {
    const { page, threadId, replyId, reviewer } = await threadWithReply();
    const bot = assistantActor({ pageId: page.id, threadId });
    expect(await failureCode(deleteMessage(db, bot, replyId))).toBe("not_allowed");
    expect(await failureCode(deleteMessage(db, reviewer, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
  });
});

describe("listThreads", () => {
  it("carries open threads forward to later versions, not closed ones", async () => {
    const { owner, reviewer, page } = await setup();
    const openOnV1 = await open(reviewer, page, { text: "still open" });
    const closedOnV1 = await open(reviewer, page, { text: "done" });
    await closeThread(db, reviewer, closedOnV1.threadId);
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>2</p>" });
    const onV2 = await open(reviewer, { versionId: v2.versionId }, { text: "new on v2" });

    const v2List = await listThreads(db, reviewer, v2.versionId);
    expect(v2List.map((t) => t.id).sort()).toEqual([openOnV1.threadId, onV2.threadId].sort());
    expect(v2List.find((t) => t.id === openOnV1.threadId)).toMatchObject({ carried: true, openedOnNumber: 1 });
    expect(v2List.find((t) => t.id === onV2.threadId)).toMatchObject({ carried: false, openedOnNumber: 2 });

    const v1List = await listThreads(db, reviewer, page.versionId);
    expect(v1List.map((t) => t.id).sort()).toEqual([openOnV1.threadId, closedOnV1.threadId].sort());
    expect(v1List.every((t) => !t.carried)).toBe(true);
    expect(v1List.find((t) => t.id === closedOnV1.threadId)!.closedAt).not.toBeNull();
  });

  it("doesn't show threads from later versions on earlier ones", async () => {
    const { owner, reviewer, page } = await setup();
    const v2 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>2</p>" });
    await open(reviewer, { versionId: v2.versionId });
    expect(await listThreads(db, reviewer, page.versionId)).toEqual([]);
  });

  it("carries through several versions and stops once closed", async () => {
    const { owner, reviewer, page } = await setup();
    const t = await open(reviewer, page);
    await addVersion(db, owner, { shortId: page.shortId, html: "<p>2</p>" });
    const v3 = await addVersion(db, owner, { shortId: page.shortId, html: "<p>3</p>" });
    expect((await listThreads(db, reviewer, v3.versionId)).map((x) => x.id)).toEqual([t.threadId]);
    await closeThread(db, owner, t.threadId);
    expect(await listThreads(db, reviewer, v3.versionId)).toEqual([]);
  });

  it("doesn't leak threads from other pages", async () => {
    const { owner, reviewer, page } = await setup();
    const other = await makePage(owner);
    await open(reviewer, other);
    expect(await listThreads(db, reviewer, page.versionId)).toEqual([]);
  });

  it("sets canClose and canDelete per viewer", async () => {
    const { owner, reviewer, bystander, page } = await setup();
    const { threadId } = await open(reviewer, page);
    await postMessage(db, bystander, { threadId, text: "reply" });

    const as = async (m: MemberActor) => (await listThreads(db, m, page.versionId))[0]!;

    const byOwner = await as(owner);
    expect(byOwner.canClose).toBe(true);
    expect(byOwner.messages.map((m) => m.canDelete)).toEqual([true, true]);

    const byOpener = await as(reviewer);
    expect(byOpener.canClose).toBe(true);
    expect(byOpener.messages.map((m) => m.canDelete)).toEqual([true, false]);

    const byReplier = await as(bystander);
    expect(byReplier.canClose).toBe(false);
    expect(byReplier.messages.map((m) => m.canDelete)).toEqual([false, true]);

    const stranger = await makeMember();
    const byStranger = await as(stranger);
    expect(byStranger.canClose).toBe(false);
    expect(byStranger.messages.map((m) => m.canDelete)).toEqual([false, false]);
  });

  it("refuses the assistant and reports an unknown version", async () => {
    const { reviewer, page } = await setup();
    expect(await failureCode(listThreads(db, assistantActor({ pageId: page.id }), page.versionId))).toBe("not_allowed");
    expect(await failureCode(listThreads(db, reviewer, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
  });
});

describe("listThreads ordering", () => {
  it("returns threads oldest first, so thread #1 is the first one opened", async () => {
    const { owner, reviewer, page } = await setup();
    const first = await open(reviewer, page, { text: "first" });
    const second = await open(owner, page, { text: "second" });
    const third = await open(reviewer, page, { text: "third" });
    const list = await listThreads(db, owner, page.versionId);
    expect(list.map((t) => t.id)).toEqual([first.threadId, second.threadId, third.threadId]);
  });
});
