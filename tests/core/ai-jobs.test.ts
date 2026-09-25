import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AI_JOB_REQUESTED } from "@/server/core/ai-jobs";
import { deleteMessage, listThreads, openThread } from "@/server/core/threads";
import { addVersion } from "@/server/core/versions";
import { aiJobs, messages, outboxEvents } from "@/server/db/tables";
import { closeTestDb, failureCode, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();

beforeEach(reset);
afterAll(closeTestDb);

async function setup() {
  const owner = await makeMember({ name: "Owner" });
  const reviewer = await makeMember({ name: "Reviewer" });
  const page = await makePage(owner);
  return { owner, reviewer, page };
}

describe("an @Claude thread", () => {
  it("creates one pending job and one outbox event, linked to the thread and its version", async () => {
    const { reviewer, page } = await setup();
    const { threadId, claudeRequested } = await openThread(db, reviewer, {
      versionId: page.versionId,
      posX: 0.5,
      posY: 0.5,
      text: "@Claude make the heading green",
    });
    expect(claudeRequested).toBe(true);

    const jobs = await db.select().from(aiJobs);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    const opening = await db.query.messages.findFirst({ where: eq(messages.threadId, threadId) });
    expect(job).toMatchObject({
      kind: "edit_page",
      status: "pending",
      pageId: page.id,
      threadId,
      requestMessageId: opening!.id,
      baseVersionId: page.versionId,
      resultVersionId: null,
      replyMessageId: null,
      attemptCount: 0,
    });

    const events = await db.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      topic: AI_JOB_REQUESTED,
      aggregateId: job.id,
      payload: { jobId: job.id }, // only the id: the worker fetches the page itself
      dispatchedAt: null,
      attempts: 0,
    });
  });

  it("an ordinary comment creates no job and no outbox event", async () => {
    const { reviewer, page } = await setup();
    await openThread(db, reviewer, { versionId: page.versionId, posX: 0.5, posY: 0.5, text: "Nice heading" });
    await openThread(db, reviewer, { versionId: page.versionId, posX: 0.5, posY: 0.5, text: "Ask @Claude later" });
    expect(await db.select().from(aiJobs)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("writes nothing when the thread itself is refused", async () => {
    const { owner, reviewer, page } = await setup();
    await addVersion(db, owner, { pageId: page.id, html: "<p>v2</p>" });
    // v1 is no longer the newest version, so the thread is refused inside the transaction.
    const code = await failureCode(
      openThread(db, reviewer, { versionId: page.versionId, posX: 0.5, posY: 0.5, text: "@Claude fix it" }),
    );
    expect(code).toBe("invalid");
    expect(await db.select().from(aiJobs)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("the database refuses a second job for the same thread and base version", async () => {
    const { reviewer, page } = await setup();
    await openThread(db, reviewer, { versionId: page.versionId, posX: 0.5, posY: 0.5, text: "@Claude fix it" });
    const [job] = await db.select().from(aiJobs);
    const error = await db
      .insert(aiJobs)
      .values({
        pageId: job!.pageId,
        threadId: job!.threadId,
        requestMessageId: job!.requestMessageId,
        baseVersionId: job!.baseVersionId,
      })
      .then(() => null, (e: Error) => e);
    // Drizzle wraps the driver error; the constraint name is on its cause.
    expect((error?.cause as { constraint_name?: string } | undefined)?.constraint_name).toBe(
      "ai_jobs_thread_base_kind_uq",
    );
  });

  it("deleting the thread deletes its job", async () => {
    const { reviewer, page } = await setup();
    const { threadId } = await openThread(db, reviewer, {
      versionId: page.versionId,
      posX: 0.5,
      posY: 0.5,
      text: "@Claude fix it",
    });
    const opening = await db.query.messages.findFirst({ where: eq(messages.threadId, threadId) });
    await deleteMessage(db, reviewer, opening!.id);
    expect(await db.select().from(aiJobs)).toHaveLength(0);
  });
});

describe("listThreads shows the job", () => {
  it("as pending, then with the version it produced, and null for ordinary threads", async () => {
    const { owner, reviewer, page } = await setup();
    await openThread(db, reviewer, { versionId: page.versionId, posX: 0.1, posY: 0.1, text: "Plain comment" });
    await openThread(db, reviewer, { versionId: page.versionId, posX: 0.2, posY: 0.2, text: "@Claude fix it" });

    let [plain, asked] = await listThreads(db, reviewer, page.versionId);
    expect(plain!.aiJob).toBeNull();
    expect(asked!.aiJob).toEqual({ status: "pending", error: null, resultVersionNumber: null });

    const v2 = await addVersion(db, owner, { pageId: page.id, html: "<p>fixed</p>" });
    await db.update(aiJobs).set({ status: "completed", resultVersionId: v2.versionId });
    [plain, asked] = await listThreads(db, reviewer, page.versionId);
    expect(asked!.aiJob).toEqual({ status: "completed", error: null, resultVersionNumber: 2 });

    await db.update(aiJobs).set({ status: "failed", resultVersionId: null, error: "The model timed out" });
    [, asked] = await listThreads(db, reviewer, page.versionId);
    expect(asked!.aiJob).toEqual({ status: "failed", error: "The model timed out", resultVersionNumber: null });
  });
});
