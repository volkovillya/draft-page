import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { MemberActor } from "@/server/core/actor";
import { aiLimitsFromEnv, DEFAULT_AI_LIMITS, type AiLimits } from "@/server/core/ai-limits";
import { claimJob, completeJob } from "@/server/core/ai-worker";
import { openThread } from "@/server/core/threads";
import { aiJobs, aiRequests, threads } from "@/server/db/tables";
import { closeTestDb, failureCode, makeMember, makePage, reset, testDb, type MadePage } from "../helpers/db";

const db = testDb();

beforeEach(reset);
afterAll(closeTestDb);

/** Generous defaults, so each test only states the limit it's about. */
const lim = (over: Partial<AiLimits> = {}): AiLimits => ({
  perMember: 100,
  total: 100,
  monthlyBudgetUsd: 100,
  reserveUsd: 0.05,
  maxPageBytes: 100 * 1024,
  ...over,
});

function ask(actor: MemberActor, page: MadePage, limits: Partial<AiLimits>, text = "@Claude make it blue") {
  return openThread(db, actor, { versionId: page.versionId, posX: 0.5, posY: 0.5, text }, lim(limits));
}

async function jobOf(threadId: string) {
  return (await db.query.aiJobs.findFirst({ where: eq(aiJobs.threadId, threadId) }))!.id;
}

async function spent(): Promise<number> {
  const [row] = await db
    .select({
      n: sql<string>`coalesce(sum(coalesce(cost_usd, reserved_usd) + reserved_usd * (attempts - 1)), 0)`,
    })
    .from(aiRequests);
  return Number(row!.n);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).toBe("too_many");
    return (error as Error).message;
  }
  throw new Error("Expected the request to be refused");
}

async function count(table: typeof threads | typeof aiJobs | typeof aiRequests) {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(table);
  return row!.n;
}

describe("daily AI limits", () => {
  it("allows each person their own allowance, then refuses with a 429 and keeps nothing", async () => {
    const [ana, ben] = [await makeMember({ name: "Ana" }), await makeMember({ name: "Ben" })];
    const page = await makePage(ana);
    const limits = { perMember: 2 };

    await ask(ana, page, limits);
    await ask(ana, page, limits);
    const message = await refusal(ask(ana, page, limits));
    expect(message).toMatch(/^You've used your 2 AI edits for the last 24 hours\. Try again in about 24 hours\./);
    expect(message).toContain('remove "@Claude"');
    // The refusal rolled back the whole thread, so the reviewer can edit and resend.
    expect(await count(threads)).toBe(2);
    expect(await count(aiJobs)).toBe(2);

    await ask(ben, page, limits); // someone else still has theirs
    expect(await count(aiRequests)).toBe(3);
  });

  it("caps everyone together", async () => {
    const [ana, ben, cy] = [await makeMember(), await makeMember(), await makeMember()];
    const page = await makePage(ana);
    const limits = { perMember: 2, total: 3 };

    await ask(ana, page, limits);
    await ask(ana, page, limits);
    await ask(ben, page, limits);
    expect(await refusal(ask(cy, page, limits))).toMatch(
      /^Everyone together has used the 3 AI edits for the last 24 hours\./,
    );
  });

  it("still accepts normal comments at the limit", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { perMember: 1, total: 1 };
    await ask(ana, page, limits);
    const plain = await ask(ana, page, limits, "Looks good");
    expect(plain.claudeRequested).toBe(false);
  });

  it("doesn't give the allowance back when the thread is deleted", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { perMember: 1, total: 10 };
    const { threadId } = await ask(ana, page, limits);
    await db.delete(threads).where(eq(threads.id, threadId)); // cascades to the job
    expect(await count(aiJobs)).toBe(0);
    await refusal(ask(ana, page, limits));
  });

  it("counts a rolling 24 hours and says when the next edit frees up", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { perMember: 1, total: 10 };
    await db.insert(aiRequests).values([
      {
        memberId: ana.memberId,
        jobId: crypto.randomUUID(),
        createdAt: sql`now() - interval '25 hours'`,
      },
      {
        memberId: ana.memberId,
        jobId: crypto.randomUUID(),
        createdAt: sql`now() - interval '23 hours 50 minutes'`,
      },
    ]);
    // The 25-hour-old request no longer counts; the other one frees up in ~10 minutes.
    expect(await refusal(ask(ana, page, limits))).toContain("Try again in about 10 minutes.");
  });

  it("lets only one of two simultaneous requests take the last slot", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { perMember: 1, total: 10 };
    const results = await Promise.allSettled([ask(ana, page, limits), ask(ana, page, limits)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count(aiRequests)).toBe(1);
  });

  it("a limit of 0 turns AI edits off", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    expect(await refusal(ask(ana, page, { perMember: 0 }))).toMatch(/^AI edits are turned off right now\./);
    expect(await failureCode(ask(ana, page, { total: 0 }))).toBe("too_many");
  });
});

describe("monthly AI budget", () => {
  function resetsOn(): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  }

  it("refuses an edit whose worst case could pass the budget, so it's never exceeded", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { monthlyBudgetUsd: 0.1, reserveUsd: 0.05 };
    await ask(ana, page, limits);
    await ask(ana, page, limits); // $0.10 held: exactly the budget
    expect(await refusal(ask(ana, page, limits))).toBe(
      `This month's AI budget ($0.10) is used up. It resets on ${resetsOn()}. To post it as a normal comment, remove "@Claude".`,
    );
    expect(await spent()).toBeCloseTo(0.1);
  });

  it("replaces the hold with the real cost when the edit finishes, freeing the rest", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = { monthlyBudgetUsd: 0.05, reserveUsd: 0.05 };
    const { threadId } = await ask(ana, page, limits);
    await refusal(ask(ana, page, limits));

    const jobId = await jobOf(threadId);
    await claimJob(db, jobId);
    const made = await completeJob(db, jobId, {
      html: "<p>edited</p>",
      summary: "Done.",
      provider: "bedrock",
      model: "m",
      estimatedCostUsd: 0.004,
    });
    expect(await spent()).toBeCloseTo(0.004);
    const newest = { ...page, versionId: made.versionId }; // comments go on the newest version
    await refusal(ask(ana, newest, limits)); // 0.004 + 0.05 > 0.05
    await ask(ana, newest, { monthlyBudgetUsd: 0.06, reserveUsd: 0.05 });
  });

  it("holds another worst case for each retry, which may be billed again", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const jobId = await jobOf((await ask(ana, page, {})).threadId);
    await claimJob(db, jobId);
    expect(await spent()).toBeCloseTo(0.05);
    await claimJob(db, jobId); // the first attempt timed out; SQS delivers again
    await claimJob(db, jobId);
    expect(await spent()).toBeCloseTo(0.15);
    await completeJob(db, jobId, {
      html: "<p>edited</p>",
      summary: "Done.",
      provider: "bedrock",
      model: "m",
      estimatedCostUsd: 0.01,
    });
    expect(await spent()).toBeCloseTo(0.11); // two held attempts + the last one's real cost
  });

  async function jobError(jobId: string) {
    return (await db.query.aiJobs.findFirst({ where: eq(aiJobs.id, jobId) }))!;
  }

  it("stops retrying when this month's budget can't hold another attempt", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const limits = lim({ monthlyBudgetUsd: 0.1, reserveUsd: 0.05 });
    const jobId = await jobOf((await ask(ana, page, limits)).threadId);
    expect((await claimJob(db, jobId, limits)).state).toBe("ready");
    expect((await claimJob(db, jobId, limits)).state).toBe("ready"); // 0.05 + 0.05 fits exactly
    expect(await claimJob(db, jobId, limits)).toEqual({ state: "done", status: "failed" });
    expect(await jobError(jobId)).toMatchObject({
      status: "failed",
      attemptCount: 2,
      error: "This month's AI budget ran out before Claude could try again",
    });
    expect(await spent()).toBeCloseTo(0.1);
  });

  it("never runs a job more than 3 times, whatever the queue delivers", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const jobId = await jobOf((await ask(ana, page, {})).threadId);
    for (let i = 0; i < 3; i++) expect((await claimJob(db, jobId, lim())).state).toBe("ready");
    expect(await claimJob(db, jobId, lim())).toEqual({ state: "done", status: "failed" });
    expect(await jobError(jobId)).toMatchObject({
      attemptCount: 3,
      error: "Claude couldn't finish this edit in 3 attempts",
    });
  });

  it("refuses a job that bypassed the limits (no ai_requests row)", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const jobId = await jobOf((await ask(ana, page, {})).threadId);
    await db.delete(aiRequests);
    expect(await claimJob(db, jobId, lim())).toEqual({ state: "done", status: "failed" });
    expect(await jobError(jobId)).toMatchObject({ attemptCount: 0, error: "Claude couldn't start this edit" });
  });

  it("releases the hold when a job is refused before any model call", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const { threadId } = await ask(ana, page, {});
    await db
      .update(threads)
      .set({ closedAt: sql`now()` })
      .where(eq(threads.id, threadId));
    expect(await claimJob(db, await jobOf(threadId), lim())).toEqual({ state: "done", status: "failed" });
    expect(await spent()).toBe(0);
  });

  it("keeps the hold when the cost is unknown or the job fails, and survives deleting the thread", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    const jobId = await jobOf((await ask(ana, page, {})).threadId);
    await claimJob(db, jobId);
    await completeJob(db, jobId, {
      html: "<p>edited</p>",
      summary: "Done.",
      provider: "bedrock",
      model: "unpriced",
    });
    await db.delete(threads);
    expect(await spent()).toBeCloseTo(0.05);
  });

  it("starts over each calendar month (UTC), like the AWS bill", async () => {
    const ana = await makeMember();
    const page = await makePage(ana);
    await db.insert(aiRequests).values({
      memberId: ana.memberId,
      jobId: crypto.randomUUID(),
      reservedUsd: "5",
      createdAt: sql`date_trunc('month', now(), 'UTC') - interval '1 second'`,
    });
    await ask(ana, page, { monthlyBudgetUsd: 1 });
  });
});

describe("aiLimitsFromEnv", () => {
  it("limits the page size by the model's reply cap", () => {
    const pageLimit = (model: string) =>
      aiLimitsFromEnv({ DRAFTPAGE_AI_EDITOR: "bedrock", DRAFTPAGE_AI_MODEL_ID: model }).maxPageBytes;
    expect(aiLimitsFromEnv({}).maxPageBytes).toBe(100 * 1024); // the fake: the input cap
    expect(pageLimit("openai.gpt-oss-120b-1:0")).toBe(28_800); // 16k reply cap
    expect(pageLimit("us.openai.gpt-5.6-luna")).toBe(67_200); // our 32k cap
  });

  it("defaults to 10 per person, 30 in total and $5 a month", () => {
    expect(aiLimitsFromEnv({})).toEqual({
      perMember: 10,
      total: 30,
      monthlyBudgetUsd: 5,
      reserveUsd: 0,
      maxPageBytes: 100 * 1024,
    });
    expect(DEFAULT_AI_LIMITS).toEqual({ perMember: 10, total: 30, monthlyBudgetUsd: 5 });
  });

  it("reads whole numbers (and dollars and cents for the budget), including 0", () => {
    expect(
      aiLimitsFromEnv({
        DRAFTPAGE_AI_LIMIT_PER_MEMBER: " 5 ",
        DRAFTPAGE_AI_LIMIT_TOTAL: "0",
        DRAFTPAGE_AI_MONTHLY_BUDGET_USD: "2.5",
      }),
    ).toMatchObject({ perMember: 5, total: 0, monthlyBudgetUsd: 2.5 });
  });

  it("fails loudly on anything else instead of guessing", () => {
    for (const bad of ["-1", "1.5", "ten", "1e3"]) {
      expect(() => aiLimitsFromEnv({ DRAFTPAGE_AI_LIMIT_TOTAL: bad })).toThrow(
        "DRAFTPAGE_AI_LIMIT_TOTAL must be a number",
      );
    }
    for (const bad of ["-1", "5$", "1.234", "five"]) {
      expect(() => aiLimitsFromEnv({ DRAFTPAGE_AI_MONTHLY_BUDGET_USD: bad })).toThrow(
        "DRAFTPAGE_AI_MONTHLY_BUDGET_USD must be a number",
      );
    }
  });

  it("prices the hold from the configured model: free for the fake, the worst case for a real one", () => {
    expect(aiLimitsFromEnv({ DRAFTPAGE_AI_EDITOR: "fake" }).reserveUsd).toBe(0);
    const luna = aiLimitsFromEnv({
      DRAFTPAGE_AI_EDITOR: "bedrock",
      DRAFTPAGE_AI_MODEL_ID: "openai.gpt-5.6-luna",
    }).reserveUsd;
    expect(luna).toBeCloseTo(0.078, 3); // ≤160 KiB of prompt (tokens ≤ bytes) × $0.22 + 32k out × $1.32 per 1M
    const haiku = aiLimitsFromEnv({
      DRAFTPAGE_AI_EDITOR: "bedrock",
      DRAFTPAGE_AI_MODEL_ID: "global.anthropic.claude-haiku-4-5",
    }).reserveUsd;
    expect(haiku).toBeCloseTo(0.324, 3);
    const gptOss = aiLimitsFromEnv({
      DRAFTPAGE_AI_EDITOR: "bedrock",
      DRAFTPAGE_AI_MODEL_ID: "openai.gpt-oss-120b-1:0",
    }).reserveUsd;
    expect(gptOss).toBeCloseTo(0.034, 3); // 160 KiB × $0.15 + its 16k reply cap × $0.60 per 1M
    // A model missing from the price table is refused rather than guessed.
    expect(() => aiLimitsFromEnv({ DRAFTPAGE_AI_EDITOR: "bedrock", DRAFTPAGE_AI_MODEL_ID: "new-model" })).toThrow(
      'No price for AI model "new-model"',
    );
  });
});
