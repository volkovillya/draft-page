/**
 * The worker-facing side of AI jobs: claim, complete, fail. The Lambda worker reaches these
 * through the internal API (src/app/api/internal); it never touches the database itself (D11).
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/connection";
import { aiJobs, messages, pageVersions, threads } from "../db/tables";
import type { AssistantActor } from "./actor";
import { MAX_JOB_ATTEMPTS, type AiJobStatus } from "./ai-jobs";
import { aiLimitsFromEnv, chargeAiAttempt, settleAiCost, type AiLimits } from "./ai-limits";
import { parseClaudeRequest } from "./claude-trigger";
import { conflict, invalid, missing } from "./failures";
import { requireHtml, requireText, requireUuid } from "./guards";
import { appendMessage } from "./threads";
import { appendVersion } from "./versions";

/** Everything the worker needs to run one edit. All text fields are untrusted user content. */
export type ClaimedJob = {
  jobId: string;
  attempt: number;
  html: string;
  instruction: string;
  excerpt: string | null;
  targetPath: string | null;
};

/** `done`: the job already finished (a duplicate delivery); the worker just acknowledges it. */
export type ClaimResult = { state: "ready"; job: ClaimedJob } | { state: "done"; status: AiJobStatus };

/**
 * The worker starts (or retries) a job: pending/processing → processing, attempt + 1.
 * A finished job is reported as done, so a duplicate SQS delivery does no work. A job whose
 * thread was resolved or whose request can't be read is failed here, before any model call.
 */
export async function claimJob(db: Db, jobId: string, limits: AiLimits = aiLimitsFromEnv()): Promise<ClaimResult> {
  requireUuid(jobId, "Job");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        job: aiJobs,
        closedAt: threads.closedAt,
        request: messages.text,
        html: pageVersions.html,
        excerpt: threads.excerpt,
        targetPath: threads.targetPath,
      })
      .from(aiJobs)
      .innerJoin(threads, eq(threads.id, aiJobs.threadId))
      .innerJoin(messages, eq(messages.id, aiJobs.requestMessageId))
      .innerJoin(pageVersions, eq(pageVersions.id, aiJobs.baseVersionId))
      .where(eq(aiJobs.id, jobId))
      .for("update", { of: aiJobs });
    if (!row) throw missing("Job");
    const { job } = row;
    if (job.status === "completed" || job.status === "failed") return { state: "done", status: job.status };

    const request = parseClaudeRequest(row.request);
    const refusal = row.closedAt
      ? "The thread was resolved before Claude started"
      : request.requested
        ? null
        : "The request could not be read";
    if (refusal) {
      await markFailed(tx, jobId, refusal);
      if (job.attemptCount === 0) await settleAiCost(tx, jobId, "0"); // no model call was made
      return { state: "done", status: "failed" };
    }

    // The server's own cap, whatever the queue does (duplicate deliveries, a manual DLQ redrive).
    const attempt = job.attemptCount + 1;
    if (attempt > MAX_JOB_ATTEMPTS) {
      await markFailed(tx, jobId, `Claude couldn't finish this edit in ${MAX_JOB_ATTEMPTS} attempts`);
      return { state: "done", status: "failed" };
    }
    const charge = await chargeAiAttempt(tx, jobId, attempt, limits);
    if (charge !== "ok") {
      await markFailed(
        tx,
        jobId,
        charge === "over_budget"
          ? "This month's AI budget ran out before Claude could try again"
          : "Claude couldn't start this edit",
      );
      return { state: "done", status: "failed" };
    }

    const [updated] = await tx
      .update(aiJobs)
      .set({
        status: "processing",
        attemptCount: sql`${aiJobs.attemptCount} + 1`,
        startedAt: sql`coalesce(${aiJobs.startedAt}, now())`,
      })
      .where(eq(aiJobs.id, jobId))
      .returning({ attempt: aiJobs.attemptCount });
    return {
      state: "ready",
      job: {
        jobId,
        attempt: updated!.attempt,
        html: row.html,
        instruction: request.instruction,
        excerpt: row.excerpt,
        targetPath: row.targetPath,
      },
    };
  });
}

export type CompleteJobInput = {
  html: unknown;
  summary: unknown;
  provider: unknown;
  model: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  estimatedCostUsd?: unknown;
  latencyMs?: unknown;
};

export const MAX_SUMMARY_LENGTH = 2000;

/**
 * Saves a successful edit in ONE transaction (§19): the new draft version, Claude's reply in
 * the thread, and the job marked completed with its usage numbers. Only ever a draft: the
 * assistant can't publish. Idempotent: completing a completed job returns the same version.
 */
export async function completeJob(
  db: Db,
  jobId: string,
  input: CompleteJobInput,
): Promise<{ versionId: string; versionNumber: number }> {
  requireUuid(jobId, "Job");
  const html = requireHtml(input.html);
  const summary = requireText(input.summary, "Summary", 1, MAX_SUMMARY_LENGTH);
  const provider = requireText(input.provider, "Provider", 1, 50);
  const model = requireText(input.model, "Model", 1, 200);
  const cost = optionalCost(input.estimatedCostUsd);

  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(aiJobs).where(eq(aiJobs.id, jobId)).for("update");
    if (!job) throw missing("Job");
    if (job.status === "completed" && job.resultVersionId) {
      const done = await tx.query.pageVersions.findFirst({
        where: eq(pageVersions.id, job.resultVersionId),
        columns: { id: true, number: true },
      });
      return { versionId: done!.id, versionNumber: done!.number };
    }
    if (job.status !== "processing") throw conflict(`The job is ${job.status}, not processing`);

    const actor: AssistantActor = { kind: "assistant", jobId, pageId: job.pageId, threadId: job.threadId };
    const version = await appendVersion(tx, actor, {
      pageId: job.pageId,
      html,
      basedOnVersionId: job.baseVersionId,
    });
    const reply = await appendMessage(tx, actor, {
      threadId: job.threadId,
      text: `${summary}\n\nDraft v${version.number} is ready for review.`,
    });
    await tx
      .update(aiJobs)
      .set({
        status: "completed",
        resultVersionId: version.versionId,
        replyMessageId: reply.messageId,
        provider,
        model,
        inputTokens: optionalCount(input.inputTokens),
        outputTokens: optionalCount(input.outputTokens),
        estimatedCostUsd: cost,
        latencyMs: optionalCount(input.latencyMs),
        error: null,
        completedAt: sql`now()`,
      })
      .where(eq(aiJobs.id, jobId));
    await settleAiCost(tx, jobId, cost);
    return { versionId: version.versionId, versionNumber: version.number };
  });
}

export const MAX_JOB_ERROR_LENGTH = 300;

/**
 * Records a permanent failure (or the last retry failing). The message is shown to reviewers,
 * so callers pass a short, user-safe sentence. A job that already finished is left alone.
 */
export async function failJob(db: Db, jobId: string, error: unknown): Promise<void> {
  requireUuid(jobId, "Job");
  const message = requireText(error, "Error", 1, 10_000).slice(0, MAX_JOB_ERROR_LENGTH);
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select({ status: aiJobs.status })
      .from(aiJobs)
      .where(eq(aiJobs.id, jobId))
      .for("update");
    if (!job) throw missing("Job");
    if (job.status === "completed" || job.status === "failed") return;
    await markFailed(tx, jobId, message);
  });
}

/**
 * Safety net for jobs whose worker died without reporting back (e.g. the last attempt
 * crashed and the message went to the dead-letter queue): anything still unfinished
 * `olderThanMinutes` after creation is marked failed. Returns how many were failed.
 */
export async function failStaleJobs(db: Db, olderThanMinutes: number): Promise<number> {
  const stale = await db
    .update(aiJobs)
    .set({ status: "failed", error: "Claude didn't finish in time", completedAt: sql`now()` })
    .where(
      and(
        inArray(aiJobs.status, ["pending", "processing"]),
        lt(aiJobs.createdAt, sql`now() - make_interval(mins => ${olderThanMinutes})`),
      ),
    )
    .returning({ id: aiJobs.id });
  return stale.length;
}

async function markFailed(tx: Tx, jobId: string, error: string) {
  await tx.update(aiJobs).set({ status: "failed", error, completedAt: sql`now()` }).where(eq(aiJobs.id, jobId));
}

function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2_000_000_000) {
    throw invalid("Counts must be non-negative integers");
  }
  return value;
}

function optionalCost(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 10_000) {
    throw invalid("Cost must be a non-negative number of dollars");
  }
  return value.toFixed(6);
}
