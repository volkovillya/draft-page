import { NextResponse } from "next/server";
import { completeJob } from "@/server/core/ai-worker";
import { getDb } from "@/server/db/connection";
import { readJson } from "@/server/http";
import { withWorker } from "@/server/worker-http";
import type { Params } from "../../../../_lib/body";

/** Saves the edit: a new draft version, Claude's reply and the job's usage, in one transaction. */
export const POST = withWorker(async (request, { params }: Params<"jobId">) => {
  const [{ jobId }, body] = await Promise.all([params, readJson(request)]);
  const done = await completeJob(getDb(), jobId, {
    html: body.html,
    summary: body.summary,
    provider: body.provider,
    model: body.model,
    inputTokens: body.inputTokens,
    outputTokens: body.outputTokens,
    estimatedCostUsd: body.estimatedCostUsd,
    latencyMs: body.latencyMs,
  });
  return NextResponse.json(done);
});
