import { notFound } from "next/navigation";
import { cache } from "react";
import { Failure } from "@/server/core/failures";
import { getPage, type PageDetail } from "@/server/core/pages";
import { getDb } from "@/server/db/connection";
import { requireMemberPage } from "@/ui/common/require-member-page";

const SHORT_ID = /^[a-z0-9]{10}$/;

/** The page for this request, or a 404. Shared by the layout, metadata and page per request. */
export const loadPage = cache(async (shortId: string): Promise<PageDetail> => {
  const actor = await requireMemberPage();
  if (!SHORT_ID.test(shortId)) notFound();
  try {
    return await getPage(getDb(), actor, shortId);
  } catch (error) {
    if (error instanceof Failure && error.code === "missing") notFound();
    throw error;
  }
});
