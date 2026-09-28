import { getDb } from "@/server/db/connection";
import { exportReview } from "@/server/core/export";
import { withMember } from "@/server/http";
import type { Params } from "../../../_lib/body";

/** Markdown digest of a version's threads, as a download. */
export const GET = withMember(async (actor, request, { params }: Params<"versionId">) => {
  const { versionId } = await params;
  const base = process.env.APP_BASE_URL ?? new URL(request.url).origin;
  const { markdown, filename } = await exportReview(getDb(), actor, versionId, base);
  return new Response(markdown, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
