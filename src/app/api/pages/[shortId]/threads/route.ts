import { NextResponse } from "next/server";
import { getDb } from "@/server/db/connection";
import { defaultVersion, getPage } from "@/server/core/pages";
import { listThreads, openThread } from "@/server/core/threads";
import { invalid, missing } from "@/server/core/failures";
import { readJson, withMember } from "@/server/http";
import { stringField, type Params } from "../../../_lib/body";

/** Threads visible on one version of the page: `?n=` picks it (default: live, else newest). */
export const GET = withMember(async (actor, request, { params }: Params<"shortId">) => {
  const { shortId } = await params;
  const n = new URL(request.url).searchParams.get("n");
  const db = getDb();
  const page = await getPage(db, actor, shortId);

  let version;
  if (n === null || n === "") {
    version = defaultVersion(page);
  } else {
    if (!/^\d{1,9}$/.test(n)) throw invalid("n must be a version number");
    version = page.versions.find((v) => v.number === Number(n));
    if (!version) throw missing("Version");
  }

  const threads = await listThreads(db, actor, version.id);
  return NextResponse.json({ versionId: version.id, versionNumber: version.number, threads });
});

/** Opens a pinned thread. Only these fields reach core; the server alone sets claude_requested_at. */
export const POST = withMember(async (actor, request, { params }: Params<"shortId">) => {
  const [{ shortId }, body] = await Promise.all([params, readJson(request)]);
  const db = getDb();
  // The version must belong to the page in the URL; core then locks and checks it again.
  const versionId = stringField(body, "versionId");
  const page = await getPage(db, actor, shortId);
  if (!page.versions.some((v) => v.id === versionId)) throw missing("Version");
  const opened = await openThread(db, actor, {
    versionId,
    posX: body.posX,
    posY: body.posY,
    targetPath: body.targetPath,
    excerpt: body.excerpt,
    text: body.text,
  });
  return NextResponse.json(opened, { status: 201 });
});
