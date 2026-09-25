import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobApi, JobApiError } from "@/worker/internal-api";

const JOB = "55555555-5555-4555-8555-555555555555";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("createJobApi", () => {
  it("posts JSON to the job's action and adds the auth headers it was given", async () => {
    const fetch = stubFetch(200, { versionId: "v", versionNumber: 2 });
    const authHeaders = vi.fn().mockResolvedValue({ authorization: "AWS4-HMAC-SHA256 …" });
    const api = createJobApi({ baseUrl: "https://abc.execute-api.eu-north-1.amazonaws.com", authHeaders });

    const saved = await api.complete(JOB, {
      html: "<p>x</p>",
      summary: "s",
      provider: "fake",
      model: "m",
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: 0,
      latencyMs: 1,
    });
    expect(saved).toEqual({ versionId: "v", versionNumber: 2 });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`https://abc.execute-api.eu-north-1.amazonaws.com/api/internal/ai-jobs/${JOB}/complete`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      host: "abc.execute-api.eu-north-1.amazonaws.com",
      authorization: "AWS4-HMAC-SHA256 …",
    });
    // The signer sees exactly what is sent, so a SigV4 signature covers the body.
    const signed = authHeaders.mock.calls[0]![0];
    expect(signed.body).toBe(init.body);
    expect(String(signed.url)).toBe(String(url));
  });

  it("turns an error answer into a JobApiError with the server's message and status", async () => {
    stubFetch(409, { error: { code: "conflict", message: "The job is failed, not processing" } });
    const api = createJobApi({ baseUrl: "http://localhost:6500", authHeaders: async () => ({}) });
    const error = await api.claim(JOB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobApiError);
    expect(error).toMatchObject({ status: 409, message: "The job is failed, not processing", permanent: true });
  });
});
