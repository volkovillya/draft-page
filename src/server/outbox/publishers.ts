import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHtmlEditor } from "../../ai";
import { createJobApi } from "../../worker/internal-api";
import { processJob, RetryLater } from "../../worker/process-job";
import { assumedRolePrefix, WORKER_IDENTITY_HEADER } from "../worker-http";
import type { OutboxMessage, Publisher } from "./relay";
import { retryDelayMs } from "./relay";

/** Same limit as the queue's redrive policy on AWS: the third failed attempt is the last. */
export const MAX_JOB_ATTEMPTS = 3;

function jobIdOf(message: OutboxMessage): string {
  const jobId = (message.payload as { jobId?: unknown } | null)?.jobId;
  if (typeof jobId !== "string") throw new Error("Outbox payload has no jobId");
  return jobId;
}

/** AWS: one SQS message per job, carrying only the job id. Credentials come from the task role. */
export function sqsPublisher(options: { queueUrl: string; region: string }): Publisher {
  const client = new SQSClient({ region: options.region });
  return async (message) => {
    await client.send(
      new SendMessageCommand({ QueueUrl: options.queueUrl, MessageBody: JSON.stringify({ jobId: jobIdOf(message) }) }),
    );
  };
}

/**
 * Local development only: stands in for SQS + Lambda inside the dev server. It runs the real
 * worker code against this server's own internal API, retrying temporary failures the way
 * the queue would (up to MAX_JOB_ATTEMPTS, with backoff).
 */
export function localWorkerPublisher(options: { baseUrl: string; workerRoleArn: string }): Publisher {
  const caller = `${assumedRolePrefix(options.workerRoleArn)}local-worker`;
  const api = createJobApi({ baseUrl: options.baseUrl, authHeaders: async () => ({ [WORKER_IDENTITY_HEADER]: caller }) });
  const editor = createHtmlEditor(process.env);
  const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ level: "info", worker: "local", ...fields }));

  const run = async (jobId: string, receiveCount: number): Promise<void> => {
    try {
      await processJob(jobId, { api, editor, receiveCount, maxAttempts: MAX_JOB_ATTEMPTS, log });
    } catch (error) {
      if (receiveCount >= MAX_JOB_ATTEMPTS) return log({ msg: "job gave up", jobId }); // SQS: → DLQ
      const why = error instanceof RetryLater ? error.reason : String((error as Error)?.name ?? error);
      log({ msg: "job will retry", jobId, receiveCount, why });
      setTimeout(() => void run(jobId, receiveCount + 1), retryDelayMs(receiveCount)).unref();
    }
  };

  return async (message) => {
    const jobId = jobIdOf(message);
    setTimeout(() => void run(jobId, 1), 0).unref(); // like SendMessage: return at once
  };
}
