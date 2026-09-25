import type { SQSEvent, SQSRecord } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ processJob: vi.fn(), send: vi.fn() }));

vi.mock("@/worker/process-job", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/worker/process-job")>()),
  processJob: m.processJob,
}));
vi.mock("@aws-sdk/client-sqs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-sqs")>()),
  SQSClient: class {
    send = m.send;
  },
}));

vi.stubEnv("DRAFTPAGE_AI_QUEUE_URL", "https://sqs.eu-north-1.amazonaws.com/000000000000/draftpage-ai-jobs");
vi.stubEnv("DRAFTPAGE_APP_URL", "https://example.execute-api.eu-north-1.amazonaws.com");
const { handler, retryVisibilitySeconds } = await import("@/worker/lambda");
const { RetryLater } = await import("@/worker/process-job");

const JOB = "66666666-6666-4666-8666-666666666666";

function record(id: string, body: string, receiveCount = 1): SQSRecord {
  return {
    messageId: id,
    receiptHandle: `rh-${id}`,
    body,
    attributes: { ApproximateReceiveCount: String(receiveCount) },
  } as unknown as SQSRecord;
}
const event = (...records: SQSRecord[]) => ({ Records: records }) as SQSEvent;

beforeEach(() => {
  vi.resetAllMocks();
  m.send.mockResolvedValue({});
});

describe("the worker Lambda", () => {
  it("passes the job id and receive count to processJob and reports success", async () => {
    m.processJob.mockResolvedValue("completed");
    expect(await handler(event(record("m1", JSON.stringify({ jobId: JOB }), 2)))).toEqual({ batchItemFailures: [] });
    expect(m.processJob).toHaveBeenCalledWith(JOB, expect.objectContaining({ receiveCount: 2, maxAttempts: 3 }));
    expect(m.send).not.toHaveBeenCalled();
  });

  it("returns only the failed message to the queue, with a backoff delay", async () => {
    m.processJob.mockResolvedValueOnce("completed").mockRejectedValueOnce(new RetryLater("busy"));
    const result = await handler(
      event(record("ok", JSON.stringify({ jobId: JOB })), record("busy", JSON.stringify({ jobId: JOB }), 1)),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "busy" }] });
    const command = m.send.mock.calls[0]![0];
    expect(command.input).toMatchObject({ ReceiptHandle: "rh-busy" });
    expect(command.input.VisibilityTimeout).toBeGreaterThanOrEqual(24);
    expect(command.input.VisibilityTimeout).toBeLessThanOrEqual(36);
  });

  it("still reports the failure when the delay can't be set", async () => {
    m.processJob.mockRejectedValue(new RetryLater("busy"));
    m.send.mockRejectedValue(new Error("AccessDenied"));
    expect(await handler(event(record("x", JSON.stringify({ jobId: JOB }))))).toEqual({
      batchItemFailures: [{ itemIdentifier: "x" }],
    });
  });

  it("leaves a message without a job id for the dead-letter queue, without calling the app", async () => {
    const result = await handler(event(record("bad1", "not json"), record("bad2", JSON.stringify({ nope: 1 }))));
    expect(result.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["bad1", "bad2"]);
    expect(m.processJob).not.toHaveBeenCalled();
  });
});

describe("retryVisibilitySeconds", () => {
  it("is ≈30 s, then ≈2 min, capped at 10 min, with ±20% jitter", () => {
    expect(retryVisibilitySeconds(1, () => 0.5)).toBe(30);
    expect(retryVisibilitySeconds(2, () => 0.5)).toBe(120);
    expect(retryVisibilitySeconds(5, () => 0.5)).toBe(600);
    expect(retryVisibilitySeconds(1, () => 0)).toBe(24);
    expect(retryVisibilitySeconds(1, () => 1)).toBe(36);
  });
});
