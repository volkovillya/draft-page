import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { deleteVersion } from "@/server/core/versions";
import { withMember } from "@/server/http";
import type { Params } from "../../_lib/body";

/** Deletes one draft version (owner only), with the threads opened on it. */
export const DELETE = withMember(async (actor, _request, { params }: Params<"versionId">) => {
  const { versionId } = await params;
  await deleteVersion(getDb(), actor, versionId);
  return NextResponse.json({ ok: true });
});
