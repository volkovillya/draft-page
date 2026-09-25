import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { createPage } from "@/server/core/pages";
import { readJson, withMember } from "@/server/http";

export const POST = withMember(async (actor, request) => {
  const body = await readJson(request);
  const created = await createPage(getDb(), actor, { title: body.title, html: body.html });
  return NextResponse.json(
    { shortId: created.shortId, versionNumber: created.versionNumber },
    { status: 201 },
  );
});
