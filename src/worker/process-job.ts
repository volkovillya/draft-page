/**
 * Runs one AI edit job end to end. The same code runs in the Lambda (one SQS message) and in
 * the local stand-in (src/server/outbox/local-worker.ts).
 *
 *   claim → model edit → complete        (success: draft version + Claude's reply)
 *   permanent error                      → fail now, with a short user-safe reason
 *   temporary error, attempts left       → throw, so the queue retries later with backoff
 *   temporary error, last attempt        → fail
 */
import { AiEditError, type HtmlEditorModel } from "../ai/html-editor";
import { JobApiError, type JobApi } from "./internal-api";

export type ProcessOutcome = "completed" | "failed" | "already-done";

export const UNEXPECTED = "The AI edit failed unexpectedly";

/** Thrown to hand the job back to the queue for another attempt. */
export class RetryLater extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RetryLater";
  }
}

export type JobLog = (fields: Record<string, unknown>) => void;

export async function processJob(
  jobId: string,
  deps: { api: JobApi; editor: HtmlEditorModel; receiveCount: number; maxAttempts: number; log?: JobLog },
): Promise<ProcessOutcome> {
  const { api, editor, receiveCount, maxAttempts } = deps;
  const log = deps.log ?? (() => {});
  const lastAttempt = receiveCount >= maxAttempts;

  // An API outage throws, so the queue retries. A job that no longer exists (its version or
  // thread was deleted) is simply dropped.
  const claimed = await api.claim(jobId).catch((error: unknown) => {
    if (error instanceof JobApiError && error.status === 404) return { state: "done" as const, status: "deleted" };
    throw error;
  });
  if (claimed.state === "done") {
    log({ msg: "job already finished", jobId, status: claimed.status });
    return "already-done";
  }

  try {
    const result = await editor.edit({
      html: claimed.job.html,
      instruction: claimed.job.instruction,
      excerpt: claimed.job.excerpt,
      targetPath: claimed.job.targetPath,
    });
    const saved = await api.complete(jobId, result);
    log({
      msg: "job completed",
      jobId,
      versionNumber: saved.versionNumber,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      latencyMs: result.latencyMs,
      attempt: claimed.job.attempt,
    });
    return "completed";
  } catch (error) {
    const { message, retryable } = classify(error);
    log({ msg: "job attempt failed", jobId, attempt: claimed.job.attempt, retryable, lastAttempt, reason: message });
    if (retryable && !lastAttempt) throw new RetryLater(message);
    await api.fail(jobId, message).catch((failError: unknown) => {
      if (!(failError instanceof JobApiError && failError.status === 404)) throw failError; // deleted meanwhile
    });
    return "failed";
  }
}

/** Only AiEditError messages are shown to people; everything else gets a generic sentence. */
function classify(error: unknown): { message: string; retryable: boolean } {
  if (error instanceof AiEditError) return { message: error.message, retryable: error.retryable };
  if (error instanceof JobApiError) {
    // e.g. the thread was resolved while Claude worked: saving can never succeed.
    return error.permanent ? { message: error.message, retryable: false } : { message: UNEXPECTED, retryable: true };
  }
  return { message: UNEXPECTED, retryable: true };
}
