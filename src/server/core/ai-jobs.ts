import { desc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/connection";
import { aiJobs, outboxEvents, pageVersions } from "../db/tables";

/** Outbox topic for a new edit job; its payload is only the job id (pages can exceed a queue message). */
export const AI_JOB_REQUESTED = "ai_job.requested";

/** At most this many model attempts per job (= maxReceiveCount of the queue's redrive policy on AWS). */
export const MAX_JOB_ATTEMPTS = 3;

export type AiJobStatus = (typeof aiJobs.$inferSelect)["status"];

/** What a thread shows about its AI request. The error is a short, user-safe sentence. */
export type AiJobView = {
  status: AiJobStatus;
  error: string | null;
  resultVersionNumber: number | null;
};

/**
 * Records an edit request and its outbox event. Must run inside the caller's transaction
 * (the one that creates the thread and its opening message), so all three commit together.
 */
export async function enqueueEditJob(
  tx: Tx,
  input: { pageId: string; threadId: string; requestMessageId: string; baseVersionId: string },
): Promise<string> {
  const [job] = await tx.insert(aiJobs).values(input).returning({ id: aiJobs.id });
  await tx.insert(outboxEvents).values({
    topic: AI_JOB_REQUESTED,
    aggregateId: job!.id,
    payload: { jobId: job!.id },
  });
  return job!.id;
}

/** The newest job per thread, for the thread list. */
export async function latestJobsByThread(db: Db, threadIds: string[]): Promise<Map<string, AiJobView>> {
  const byThread = new Map<string, AiJobView>();
  if (threadIds.length === 0) return byThread;
  const rows = await db
    .select({
      threadId: aiJobs.threadId,
      status: aiJobs.status,
      error: aiJobs.error,
      resultVersionNumber: pageVersions.number,
    })
    .from(aiJobs)
    .leftJoin(pageVersions, eq(pageVersions.id, aiJobs.resultVersionId))
    .where(inArray(aiJobs.threadId, threadIds))
    .orderBy(desc(aiJobs.createdAt));
  for (const { threadId, ...view } of rows) {
    if (!byThread.has(threadId)) byThread.set(threadId, { ...view, resultVersionNumber: view.resultVersionNumber ?? null });
  }
  return byThread;
}
