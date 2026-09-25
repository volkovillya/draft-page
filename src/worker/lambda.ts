/**
 * The AI worker Lambda (Phase 3). SQS invokes it with job messages ({ jobId }); each one runs
 * through processJob, which talks to the app over the signed internal API (decision D11).
 *
 * Retries: a temporary failure keeps the message in the queue and sets when it comes back
 * (≈30 s, then ≈2 min, with jitter) instead of waiting out the long visibility timeout. After
 * MAX_ATTEMPTS receives the job is failed by processJob; a message whose worker crashed every
 * time goes to the dead-letter queue (the queue's redrive policy).
 */
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { createHtmlEditor } from "../ai";
import { createJobApi } from "./internal-api";
import { processJob, RetryLater } from "./process-job";
import { sigV4Headers } from "./sigv4";

const env = process.env;
const region = env.AWS_REGION ?? "eu-north-1";
const maxAttempts = Number(env.DRAFTPAGE_AI_MAX_ATTEMPTS ?? 3);
const queueUrl = env.DRAFTPAGE_AI_QUEUE_URL ?? "";
const appUrl = env.DRAFTPAGE_APP_URL ?? "";

// Created once per Lambda instance and reused across invocations.
const api = createJobApi({ baseUrl: appUrl, authHeaders: sigV4Headers(region) });
const editor = createHtmlEditor(env);
const sqs = new SQSClient({ region });

function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ level: "info", ...fields }));
}

/** ≈30 s after the 1st failure, ≈2 min after the 2nd (±20%), capped at 10 min. */
export function retryVisibilitySeconds(receiveCount: number, random = Math.random): number {
  const base = Math.min(30 * 4 ** Math.max(0, receiveCount - 1), 600);
  return Math.round(base * (0.8 + 0.4 * random()));
}

async function handleRecord(record: SQSRecord): Promise<boolean> {
  const receiveCount = Number(record.attributes.ApproximateReceiveCount ?? 1);
  let jobId: unknown;
  try {
    jobId = (JSON.parse(record.body) as { jobId?: unknown }).jobId;
  } catch {
    jobId = undefined;
  }
  if (typeof jobId !== "string") {
    log({ level: "error", msg: "message without a job id", messageId: record.messageId });
    return false; // left for the dead-letter queue, where it can be inspected
  }

  try {
    const outcome = await processJob(jobId, { api, editor, receiveCount, maxAttempts, log });
    log({ msg: "job handled", jobId, outcome, receiveCount });
    return true;
  } catch (error) {
    const reason = error instanceof RetryLater ? error.reason : String((error as Error)?.name ?? error);
    const delay = retryVisibilitySeconds(receiveCount);
    log({ level: "warn", msg: "job will retry", jobId, receiveCount, delaySeconds: delay, reason });
    await sqs
      .send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: record.receiptHandle, VisibilityTimeout: delay }))
      .catch(() => log({ level: "warn", msg: "could not set retry delay; using the queue default", jobId }));
    return false;
  }
}

/** Partial batch response: only the failed messages return to the queue. */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    if (!(await handleRecord(record))) batchItemFailures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures };
}
