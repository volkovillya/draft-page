import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { postMessage } from "@/server/core/threads";
import { readJson, withMember } from "@/server/http";
import type { Params } from "../../../_lib/body";

export const POST = withMember(async (actor, request, { params }: Params<"threadId">) => {
  const [{ threadId }, body] = await Promise.all([params, readJson(request)]);
  const posted = await postMessage(getDb(), actor, { threadId, text: body.text });
  return NextResponse.json(posted, { status: 201 });
});
