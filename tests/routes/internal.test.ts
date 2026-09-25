import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Failure } from "@/server/core/failures";
import { assumedRolePrefix, WORKER_IDENTITY_HEADER } from "@/server/worker-http";
import { ctx } from "./mocks";

const m = vi.hoisted(() => ({ claimJob: vi.fn(), completeJob: vi.fn(), failJob: vi.fn() }));

vi.mock("@/server/db/connection", () => ({ getDb: () => ({}) }));
vi.mock("@/server/core/ai-worker", () => m);

const { POST: claimRoute } = await import("@/app/api/internal/ai-jobs/[jobId]/claim/route");
const { POST: completeRoute } = await import("@/app/api/internal/ai-jobs/[jobId]/complete/route");
const { POST: failRoute } = await import("@/app/api/internal/ai-jobs/[jobId]/fail/route");

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const ROLE_ARN = "arn:aws:iam::114990992449:role/draftpage-ai-worker";
const WORKER = "arn:aws:sts::114990992449:assumed-role/draftpage-ai-worker/draftpage-ai-worker";

function request(path: string, body: unknown = {}, caller: string | null = WORKER): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (caller !== null) headers[WORKER_IDENTITY_HEADER] = caller;
  return new Request(`http://localhost/api/internal/ai-jobs/${JOB_ID}/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DRAFTPAGE_WORKER_ROLE_ARN", ROLE_ARN);
});
afterEach(() => vi.unstubAllEnvs());

describe("worker authentication", () => {
  it("is switched off (404) until a worker role is configured", async () => {
    vi.stubEnv("DRAFTPAGE_WORKER_ROLE_ARN", "");
    const res = await claimRoute(request("claim"), ctx({ jobId: JOB_ID }));
    expect(res.status).toBe(404);
    expect(m.claimJob).not.toHaveBeenCalled();
  });

  it.each([
    ["no identity header", null],
    ["a person's identity", "arn:aws:sts::114990992449:assumed-role/AccountFullAccessRole/someone"],
    ["a look-alike role name", "arn:aws:sts::114990992449:assumed-role/draftpage-ai-worker-evil/x"],
    ["another account's role", "arn:aws:sts::999999999999:assumed-role/draftpage-ai-worker/x"],
    ["a second value joined onto the real one", `${WORKER}, arn:aws:sts::999999999999:assumed-role/x/y`],
    ["anything after the session name", `${WORKER}/extra`],
  ])("refuses %s with 403", async (_label, caller) => {
    for (const [route, path] of [
      [claimRoute, "claim"],
      [completeRoute, "complete"],
      [failRoute, "fail"],
    ] as const) {
      const res = await route(request(path, {}, caller), ctx({ jobId: JOB_ID }));
      expect(res.status).toBe(403);
    }
    expect(m.claimJob).not.toHaveBeenCalled();
    expect(m.completeJob).not.toHaveBeenCalled();
    expect(m.failJob).not.toHaveBeenCalled();
  });

  it("turns a role ARN into the assumed-role prefix API Gateway reports", () => {
    expect(assumedRolePrefix(ROLE_ARN)).toBe("arn:aws:sts::114990992449:assumed-role/draftpage-ai-worker/");
    expect(assumedRolePrefix("arn:aws:iam::114990992449:role/path/to/r1")).toBe(
      "arn:aws:sts::114990992449:assumed-role/r1/",
    );
    expect(assumedRolePrefix("arn:aws:iam::114990992449:user/bob")).toBeUndefined();
    expect(assumedRolePrefix("nonsense")).toBeUndefined();
    expect(assumedRolePrefix(undefined)).toBeUndefined();
  });
});

describe("routes", () => {
  it("claim returns what core returns", async () => {
    m.claimJob.mockResolvedValue({ state: "done", status: "completed" });
    const res = await claimRoute(request("claim"), ctx({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "done", status: "completed" });
    expect(m.claimJob).toHaveBeenCalledWith({}, JOB_ID);
  });

  it("complete forwards only the result fields", async () => {
    m.completeJob.mockResolvedValue({ versionId: "v", versionNumber: 2 });
    const body = {
      html: "<p>x</p>",
      summary: "Done.",
      provider: "fake",
      model: "fake-editor",
      inputTokens: 1,
      outputTokens: 2,
      estimatedCostUsd: 0,
      latencyMs: 3,
      state: "live", // not a result field: must never reach core
      threadId: "someone-else",
    };
    const res = await completeRoute(request("complete", body), ctx({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    const { state: _state, threadId: _thread, ...forwarded } = body;
    expect(m.completeJob).toHaveBeenCalledWith({}, JOB_ID, forwarded);
  });

  it("maps core failures to their HTTP status", async () => {
    m.completeJob.mockRejectedValue(new Failure("conflict", "The job is failed, not processing"));
    const res = await completeRoute(request("complete", { html: "<p>x</p>" }), ctx({ jobId: JOB_ID }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "The job is failed, not processing" } });
  });

  it("fail passes the reason through", async () => {
    m.failJob.mockResolvedValue(undefined);
    const res = await failRoute(request("fail", { error: "The model declined this request" }), ctx({ jobId: JOB_ID }));
    expect(res.status).toBe(200);
    expect(m.failJob).toHaveBeenCalledWith({}, JOB_ID, "The model declined this request");
  });
});
