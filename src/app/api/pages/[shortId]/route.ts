import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { deletePage } from "@/server/core/pages";
import { withMember } from "@/server/http";
import type { Params } from "../../_lib/body";

export const DELETE = withMember(async (actor, _request, { params }: Params<"shortId">) => {
  const { shortId } = await params;
  await deletePage(getDb(), actor, shortId);
  return NextResponse.json({ ok: true });
});
