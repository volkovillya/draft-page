import { describe, expect, it, vi } from "vitest";
import { AiEditError, type HtmlEditorModel, type HtmlEditResult } from "@/ai/html-editor";
import { JobApiError, type JobApi } from "@/worker/internal-api";
import { processJob, RetryLater, UNEXPECTED } from "@/worker/process-job";

const JOB = "44444444-4444-4444-8444-444444444444";
const CLAIMED = {
  state: "ready" as const,
  job: { jobId: JOB, attempt: 1, html: "<h1>Hi</h1>", instruction: "make it green", excerpt: "Hi", targetPath: "h1" },
};
const RESULT: HtmlEditResult = {
  html: "<h1 style='color:green'>Hi</h1>",
  summary: "Made it green.",
  provider: "fake",
  model: "fake-editor",
  inputTokens: null,
  outputTokens: null,
  estimatedCostUsd: 0,
  latencyMs: 1,
};

function api(overrides: Partial<Record<keyof JobApi, unknown>> = {}) {
  return {
    claim: vi.fn().mockResolvedValue(CLAIMED),
    complete: vi.fn().mockResolvedValue({ versionId: "v2", versionNumber: 2 }),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as JobApi & Record<keyof JobApi, ReturnType<typeof vi.fn>>;
}
const editor = (edit: () => Promise<HtmlEditResult>): HtmlEditorModel => ({ edit: vi.fn(edit) });
const ok = editor(async () => RESULT);
const run = (a: JobApi, e: HtmlEditorModel, receiveCount = 1) =>
  processJob(JOB, { api: a, editor: e, receiveCount, maxAttempts: 3 });

describe("processJob", () => {
  it("claims, edits and completes, passing only the request fields to the model", async () => {
    const a = api();
    const e = ok;
    expect(await run(a, e)).toBe("completed");
    expect(e.edit).toHaveBeenCalledWith({ html: "<h1>Hi</h1>", instruction: "make it green", excerpt: "Hi", targetPath: "h1" });
    expect(a.complete).toHaveBeenCalledWith(JOB, RESULT);
    expect(a.fail).not.toHaveBeenCalled();
  });

  it("does nothing for a job that already finished (duplicate delivery)", async () => {
    const a = api({ claim: vi.fn().mockResolvedValue({ state: "done", status: "completed" }) });
    const e = editor(async () => RESULT);
    expect(await run(a, e)).toBe("already-done");
    expect(e.edit).not.toHaveBeenCalled();
    expect(a.complete).not.toHaveBeenCalled();
  });

  it("fails at once on a permanent model error, with the model's user-safe reason", async () => {
    const a = api();
    expect(await run(a, editor(async () => Promise.reject(new AiEditError("The model declined this request", false))))).toBe(
      "failed",
    );
    expect(a.fail).toHaveBeenCalledWith(JOB, "The model declined this request");
  });

  it("hands a temporary error back to the queue while attempts are left", async () => {
    const a = api();
    const busy = editor(async () => Promise.reject(new AiEditError("The AI service is busy or unavailable right now", true)));
    await expect(run(a, busy, 1)).rejects.toBeInstanceOf(RetryLater);
    await expect(run(a, busy, 2)).rejects.toBeInstanceOf(RetryLater);
    expect(a.fail).not.toHaveBeenCalled();
    expect(await run(a, busy, 3)).toBe("failed"); // last attempt
    expect(a.fail).toHaveBeenCalledWith(JOB, "The AI service is busy or unavailable right now");
  });

  it("fails with the API's reason when saving is refused (e.g. the thread was resolved)", async () => {
    const a = api({ complete: vi.fn().mockRejectedValue(new JobApiError("This thread is resolved; reopen it to reply", 400)) });
    expect(await run(a, ok)).toBe("failed");
    expect(a.fail).toHaveBeenCalledWith(JOB, "This thread is resolved; reopen it to reply");
  });

  it("retries unexpected errors and never shows their text", async () => {
    const a = api({ complete: vi.fn().mockRejectedValue(new Error("ECONNRESET 10.0.3.7 secret-ish detail")) });
    await expect(run(a, ok, 1)).rejects.toBeInstanceOf(RetryLater);
    expect(await run(a, ok, 3)).toBe("failed");
    expect(a.fail).toHaveBeenCalledWith(JOB, UNEXPECTED);
  });

  it("drops a job that was deleted (with its version or thread) instead of retrying", async () => {
    const a = api({ claim: vi.fn().mockRejectedValue(new JobApiError("Job not found", 404)) });
    const e = editor(async () => RESULT);
    expect(await run(a, e)).toBe("already-done");
    expect(e.edit).not.toHaveBeenCalled();

    const gone = api({
      complete: vi.fn().mockRejectedValue(new JobApiError("Job not found", 404)),
      fail: vi.fn().mockRejectedValue(new JobApiError("Job not found", 404)),
    });
    expect(await run(gone, ok)).toBe("failed"); // nothing left to report to, and no retry loop
  });

  it("a claim that can't reach the app throws, so the queue retries it", async () => {
    const a = api({ claim: vi.fn().mockRejectedValue(new JobApiError("Job API claim failed", 503)) });
    await expect(run(a, ok)).rejects.toThrow("Job API claim failed");
    expect(a.fail).not.toHaveBeenCalled();
  });
});

describe("JobApiError.permanent", () => {
  it("treats 4xx as permanent except timeouts and throttling", () => {
    expect(new JobApiError("x", 400).permanent).toBe(true);
    expect(new JobApiError("x", 409).permanent).toBe(true);
    expect(new JobApiError("x", 408).permanent).toBe(false);
    expect(new JobApiError("x", 429).permanent).toBe(false);
    expect(new JobApiError("x", 502).permanent).toBe(false);
  });
});
