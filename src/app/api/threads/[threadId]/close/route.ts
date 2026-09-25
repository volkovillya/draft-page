import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { closeThread } from "@/server/core/threads";
import { withMember } from "@/server/http";
import type { Params } from "../../../_lib/body";

export const POST = withMember(async (actor, _request, { params }: Params<"threadId">) => {
  const { threadId } = await params;
  await closeThread(getDb(), actor, threadId);
  return NextResponse.json({ ok: true });
});
