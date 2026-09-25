import { NextResponse } from "next/server";
import { claimJob } from "@/server/core/ai-worker";
import { getDb } from "@/server/db/connection";
import { withWorker } from "@/server/worker-http";
import type { Params } from "../../../../_lib/body";

/** The worker starts (or retries) a job and receives the page and the request to edit. */
export const POST = withWorker(async (_request, { params }: Params<"jobId">) => {
  const { jobId } = await params;
  return NextResponse.json(await claimJob(getDb(), jobId));
});
