import type { Metadata } from "next";
import { defaultVersion, type PageDetail, type VersionSummary } from "@/server/core/pages";
import { listThreads } from "@/server/core/threads";
import { getDb } from "@/server/db/connection";
import { ReviewCanvas } from "@/ui/canvas/ReviewCanvas";
import { requireMemberPage } from "@/ui/common/require-member-page";
import { loadPage } from "./load-page";

type Props = {
  params: Promise<{ shortId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `?n=3` picks a version; anything missing or unknown falls back to live, else newest. */
function chooseVersion(detail: PageDetail, raw: string | string[] | undefined): VersionSummary {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^\d{1,9}$/.test(value)) {
    const n = Number(value);
    const match = detail.versions.find((v) => v.number === n);
    if (match) return match;
  }
  return defaultVersion(detail);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shortId } = await params;
  const detail = await loadPage(shortId);
  return { title: detail.title };
}

export default async function ReviewPage({ params, searchParams }: Props) {
  const [actor, { shortId }, query] = await Promise.all([requireMemberPage(), params, searchParams]);
  const detail = await loadPage(shortId);
  const version = chooseVersion(detail, query.n);
  const threads = await listThreads(getDb(), actor, version.id);

  return (
    <ReviewCanvas
      // A different version is a fresh canvas: new frame, threads and selection.
      key={version.id}
      page={{
        shortId: detail.shortId,
        title: detail.title,
        ownerName: detail.ownerName,
        isOwner: detail.isOwner,
        versions: detail.versions,
      }}
      version={version}
      initialThreads={threads}
      memberName={actor.name}
    />
  );
}
