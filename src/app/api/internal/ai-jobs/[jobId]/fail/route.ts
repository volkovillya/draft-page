import { NextResponse } from "next/server";
import { failJob } from "@/server/core/ai-worker";
import { getDb } from "@/server/db/connection";
import { readJson } from "@/server/http";
import { withWorker } from "@/server/worker-http";
import type { Params } from "../../../../_lib/body";

/** Marks the job failed with a short, user-safe reason (permanent error or last retry). */
export const POST = withWorker(async (request, { params }: Params<"jobId">) => {
  const [{ jobId }, body] = await Promise.all([params, readJson(request)]);
  await failJob(getDb(), jobId, body.error);
  return NextResponse.json({ ok: true });
});
