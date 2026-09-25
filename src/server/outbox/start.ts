/**
 * Chooses where AI jobs go when the server starts (imported by src/instrumentation.ts):
 * - DRAFTPAGE_AI_QUEUE_URL set (AWS)          → SQS, picked up by the Lambda worker
 * - DRAFTPAGE_AI_LOCAL_WORKER=on (dev, e2e)   → the in-process stand-in, no AWS needed
 * - neither                                   → relay off; jobs wait as "pending"
 */
import { getDb } from "../db/connection";
import { localWorkerPublisher, sqsPublisher } from "./publishers";
import { startRelay } from "./relay";

const env = process.env;
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level: "info", msg, ...fields }));

if (env.DRAFTPAGE_AI_QUEUE_URL) {
  const region = env.AWS_REGION;
  if (!region) throw new Error("AWS_REGION is required with DRAFTPAGE_AI_QUEUE_URL");
  startRelay({ db: getDb, publish: sqsPublisher({ queueUrl: env.DRAFTPAGE_AI_QUEUE_URL, region }) });
  log("outbox relay started", { target: "sqs" });
} else if (env.DRAFTPAGE_AI_LOCAL_WORKER === "on") {
  const baseUrl = env.DRAFTPAGE_AI_LOCAL_WORKER_URL;
  const workerRoleArn = env.DRAFTPAGE_WORKER_ROLE_ARN;
  if (!baseUrl || !workerRoleArn) {
    throw new Error("DRAFTPAGE_AI_LOCAL_WORKER=on needs DRAFTPAGE_AI_LOCAL_WORKER_URL and DRAFTPAGE_WORKER_ROLE_ARN");
  }
  startRelay({ db: getDb, publish: localWorkerPublisher({ baseUrl, workerRoleArn }) });
  log("outbox relay started", { target: "local-worker", editor: env.DRAFTPAGE_AI_EDITOR || "fake" });
} else {
  log("outbox relay off: AI jobs stay pending (set DRAFTPAGE_AI_LOCAL_WORKER=on to run them locally)");
}
