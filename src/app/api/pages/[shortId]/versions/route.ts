import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { addVersion } from "@/server/core/versions";
import { readJson, withMember } from "@/server/http";
import type { Params } from "../../../_lib/body";

export const POST = withMember(async (actor, request, { params }: Params<"shortId">) => {
  const [{ shortId }, body] = await Promise.all([params, readJson(request)]);
  const added = await addVersion(getDb(), actor, { shortId, html: body.html });
  return NextResponse.json(added, { status: 201 });
});
