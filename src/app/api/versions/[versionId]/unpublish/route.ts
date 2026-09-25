import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { unpublishVersion } from "@/server/core/versions";
import { withMember } from "@/server/http";
import type { Params } from "../../../_lib/body";

export const POST = withMember(async (actor, _request, { params }: Params<"versionId">) => {
  const { versionId } = await params;
  await unpublishVersion(getDb(), actor, versionId);
  return NextResponse.json({ ok: true });
});
