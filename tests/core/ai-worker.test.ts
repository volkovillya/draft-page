import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { claimJob, completeJob, failJob, failStaleJobs } from "@/server/core/ai-worker";
import { closeThread, openThread } from "@/server/core/threads";
import { publishVersion } from "@/server/core/versions";
import { aiJobs, messages, pageVersions, threads } from "@/server/db/tables";
import { closeTestDb, failureCode, makeMember, makePage, reset, testDb } from "../helpers/db";

const db = testDb();

beforeEach(reset);
afterAll(closeTestDb);

const EDITED = "<!doctype html><html><body><h1 style=\"color:green\">Hello</h1></body></html>";
const RESULT = {
  html: EDITED,
  summary: "Made the heading green.",
  provider: "fake",
  model: "fake-editor",
  inputTokens: 1200,
  outputTokens: 900,
  estimatedCostUsd: 0.00132,
  latencyMs: 4200,
};

async function setup(text = "@Claude make the heading green") {
  const owner = await makeMember({ name: "Owner" });
  const reviewer = await makeMember({ name: "Reviewer" });
  const page = await makePage(owner);
  const { threadId } = await openThread(db, reviewer, {
    versionId: page.versionId,
    posX: 0.5,
    posY: 0.2,
    targetPath: "body > h1",
    excerpt: "Hello",
    text,
  });
  const [job] = await db.select().from(aiJobs).where(eq(aiJobs.threadId, threadId));
  return { owner, reviewer, page, threadId, jobId: job!.id };
}

const job = async (id: string) => (await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, id) }))!;
const versionsOf = (pageId: string) =>
  db.select().from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(pageVersions.number);
const messagesOf = (threadId: string) =>
  db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(messages.seq);

describe("claimJob", () => {
  it("hands the worker the page and the parsed request, and counts attempts", async () => {
    const { jobId } = await setup();
    const first = await claimJob(db, jobId);
    expect(first).toEqual({
      state: "ready",
      job: {
        jobId,
        attempt: 1,
        html: "<!doctype html><html><body><h1>Hello</h1></body></html>",
        instruction: "make the heading green", // "@Claude" stripped
        excerpt: "Hello",
        targetPath: "body > h1",
      },
    });
    expect(await job(jobId)).toMatchObject({ status: "processing", attemptCount: 1 });
    const startedAt = (await job(jobId)).startedAt;

    const retry = await claimJob(db, jobId); // SQS redelivered after a failed attempt
    expect(retry.state === "ready" && retry.job.attempt).toBe(2);
    expect((await job(jobId)).startedAt).toEqual(startedAt); // first start is kept
  });

  it("reports a finished job as done, so a duplicate delivery does nothing", async () => {
    const { jobId } = await setup();
    await claimJob(db, jobId);
    await completeJob(db, jobId, RESULT);
    expect(await claimJob(db, jobId)).toEqual({ state: "done", status: "completed" });
    expect((await job(jobId)).attemptCount).toBe(1);
  });

  it("fails the job without a model call when the thread was resolved first", async () => {
    const { reviewer, threadId, jobId } = await setup();
    await closeThread(db, reviewer, threadId);
    expect(await claimJob(db, jobId)).toEqual({ state: "done", status: "failed" });
    expect(await job(jobId)).toMatchObject({ status: "failed", error: "The thread was resolved before Claude started" });
  });

  it("refuses unknown and malformed ids", async () => {
    expect(await failureCode(claimJob(db, "not-a-uuid"))).toBe("invalid");
    expect(await failureCode(claimJob(db, "00000000-0000-4000-8000-000000000000"))).toBe("missing");
  });
});

describe("completeJob", () => {
  it("adds one draft version and one Claude reply, and completes the job, in one go", async () => {
    const { page, threadId, jobId } = await setup();
    await claimJob(db, jobId);
    const done = await completeJob(db, jobId, RESULT);
    expect(done.versionNumber).toBe(2);

    const [, v2] = await versionsOf(page.id);
    expect(v2).toMatchObject({
      id: done.versionId,
      html: EDITED,
      state: "draft", // AI never publishes
      origin: "assistant",
      createdByMemberId: null,
      basedOnVersionId: page.versionId,
    });

    const [, reply] = await messagesOf(threadId);
    expect(reply).toMatchObject({ authorKind: "assistant", authorMemberId: null, seq: 2 });
    expect(reply!.text).toBe("Made the heading green.\n\nDraft v2 is ready for review.");

    expect(await job(jobId)).toMatchObject({
      status: "completed",
      resultVersionId: done.versionId,
      replyMessageId: reply!.id,
      provider: "fake",
      model: "fake-editor",
      inputTokens: 1200,
      outputTokens: 900,
      estimatedCostUsd: "0.001320",
      latencyMs: 4200,
      error: null,
    });
    // AI never resolves: the thread stays open for the humans.
    expect((await db.query.threads.findFirst({ where: eq(threads.id, threadId) }))!.closedAt).toBeNull();
  });

  it("is idempotent: a duplicate completion returns the same version and adds nothing", async () => {
    const { page, threadId, jobId } = await setup();
    await claimJob(db, jobId);
    const first = await completeJob(db, jobId, RESULT);
    const second = await completeJob(db, jobId, { ...RESULT, html: "<p>a different answer</p>" });
    expect(second).toEqual(first);
    expect(await versionsOf(page.id)).toHaveLength(2);
    expect(await messagesOf(threadId)).toHaveLength(2);
  });

  it("creates exactly one version when duplicate deliveries complete at the same time", async () => {
    const { page, threadId, jobId } = await setup();
    await claimJob(db, jobId);
    const results = await Promise.all(Array.from({ length: 6 }, () => completeJob(db, jobId, RESULT)));
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
    expect(await versionsOf(page.id)).toHaveLength(2);
    expect(await messagesOf(threadId)).toHaveLength(2);
  });

  it("refuses a job the worker never claimed, and a failed one", async () => {
    const { jobId } = await setup();
    expect(await failureCode(completeJob(db, jobId, RESULT))).toBe("conflict");
    await failJob(db, jobId, "The model declined this request");
    expect(await failureCode(completeJob(db, jobId, RESULT))).toBe("conflict");
  });

  it("validates the result and writes nothing when it's rejected", async () => {
    const { page, jobId } = await setup();
    await claimJob(db, jobId);
    expect(await failureCode(completeJob(db, jobId, { ...RESULT, html: "   " }))).toBe("invalid");
    expect(await failureCode(completeJob(db, jobId, { ...RESULT, summary: "" }))).toBe("invalid");
    expect(await failureCode(completeJob(db, jobId, { ...RESULT, inputTokens: -1 }))).toBe("invalid");
    expect(await failureCode(completeJob(db, jobId, { ...RESULT, estimatedCostUsd: "free" }))).toBe("invalid");
    expect(await versionsOf(page.id)).toHaveLength(1);
    expect((await job(jobId)).status).toBe("processing");
  });

  it("rolls back the version when the thread was resolved while Claude worked", async () => {
    const { reviewer, page, threadId, jobId } = await setup();
    await claimJob(db, jobId);
    await closeThread(db, reviewer, threadId);
    expect(await failureCode(completeJob(db, jobId, RESULT))).toBe("invalid");
    expect(await versionsOf(page.id)).toHaveLength(1); // the version insert was undone too
  });

  it("the assistant's version can still only be published by a person", async () => {
    const { owner, jobId } = await setup();
    await claimJob(db, jobId);
    const { versionId } = await completeJob(db, jobId, RESULT);
    const assistant = { kind: "assistant" as const, jobId, pageId: "", threadId: "" };
    expect(await failureCode(publishVersion(db, assistant, versionId))).toBe("not_allowed");
    await publishVersion(db, owner, versionId);
  });
});

describe("failJob", () => {
  it("marks the job failed with a short user-facing reason", async () => {
    const { jobId } = await setup();
    await claimJob(db, jobId);
    await failJob(db, jobId, "The AI service is busy ".repeat(40));
    const failed = await job(jobId);
    expect(failed.status).toBe("failed");
    expect(failed.error!.length).toBe(300);
    expect(failed.completedAt).not.toBeNull();
  });

  it("never overwrites a completed job", async () => {
    const { jobId } = await setup();
    await claimJob(db, jobId);
    await completeJob(db, jobId, RESULT);
    await failJob(db, jobId, "late failure from a duplicate delivery");
    expect(await job(jobId)).toMatchObject({ status: "completed", error: null });
  });
});

describe("failStaleJobs", () => {
  it("fails jobs left unfinished too long and leaves recent ones alone", async () => {
    const stale = await setup();
    const fresh = await setup("@Claude another change");
    await claimJob(db, stale.jobId);
    await db.update(aiJobs).set({ createdAt: sql`now() - interval '2 hours'` }).where(eq(aiJobs.id, stale.jobId));

    expect(await failStaleJobs(db, 60)).toBe(1);
    expect(await job(stale.jobId)).toMatchObject({ status: "failed", error: "Claude didn't finish in time" });
    expect((await job(fresh.jobId)).status).toBe("pending");
  });
});
