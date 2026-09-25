import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { deleteMessage } from "@/server/core/threads";
import { withMember } from "@/server/http";
import type { Params } from "../../_lib/body";

export const DELETE = withMember(async (actor, _request, { params }: Params<"messageId">) => {
  const { messageId } = await params;
  await deleteMessage(getDb(), actor, messageId);
  return NextResponse.json({ ok: true });
});
