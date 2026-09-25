/**
 * The worker's client for the app's internal job API (decision D11). The worker never opens a
 * database connection: it claims a job, asks the model, and reports back over HTTPS.
 * `authHeaders` proves who is calling: SigV4 on AWS, a fixed caller header locally.
 */
import type { HtmlEditResult } from "../ai/html-editor";

export type ClaimedJob = {
  jobId: string;
  attempt: number;
  html: string;
  instruction: string;
  excerpt: string | null;
  targetPath: string | null;
};

export type ClaimResult = { state: "ready"; job: ClaimedJob } | { state: "done"; status: string };

export interface JobApi {
  claim(jobId: string): Promise<ClaimResult>;
  complete(jobId: string, result: HtmlEditResult): Promise<{ versionId: string; versionNumber: number }>;
  fail(jobId: string, error: string): Promise<void>;
}

/** An HTTP answer from the job API. 4xx means the request itself is wrong: retrying won't help. */
export class JobApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "JobApiError";
  }
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export type SignedRequest = { method: string; url: URL; headers: Record<string, string>; body: string };

export function createJobApi(options: {
  baseUrl: string;
  authHeaders: (request: SignedRequest) => Promise<Record<string, string>>;
  timeoutMs?: number;
}): JobApi {
  const timeoutMs = options.timeoutMs ?? 20_000;

  async function post<T>(jobId: string, action: string, payload: unknown): Promise<T> {
    const url = new URL(`/api/internal/ai-jobs/${encodeURIComponent(jobId)}/${action}`, options.baseUrl);
    const body = JSON.stringify(payload);
    const headers = { "content-type": "application/json", host: url.host };
    const signed = await options.authHeaders({ method: "POST", url, headers, body });
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...signed },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
      throw new JobApiError(typeof message === "string" ? message : `Job API ${action} failed`, response.status);
    }
    return data as T;
  }

  return {
    claim: (jobId) => post(jobId, "claim", {}),
    complete: (jobId, result) => post(jobId, "complete", result),
    fail: async (jobId, error) => {
      await post(jobId, "fail", { error });
    },
  };
}
