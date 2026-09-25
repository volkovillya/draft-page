import Link from "next/link";
import { MessageSquare } from "lucide-react";
import type { PageSummary } from "@/server/core/pages";
import { relativeTime } from "@/ui/common/relative-time";
import { PageThumbnail } from "./PageThumbnail";

/** A gallery card: a live, non-interactive thumbnail of the page plus its status. */
export function PageCard({ page, now }: { page: PageSummary; now: number }) {
  const live = page.liveNumber !== null;
  return (
    <li className="group min-w-0">
      <Link
        href={`/pages/${page.shortId}`}
        className="flex flex-col overflow-hidden rounded-xl bg-panel ring-1 ring-line transition-shadow hover:shadow-[var(--shadow-pop)] hover:ring-line-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-marker"
      >
        <div className="relative aspect-[16/10] overflow-hidden border-b border-line bg-white">
          <PageThumbnail versionId={page.previewVersionId} />
          <span className="absolute inset-0 transition-colors group-hover:bg-black/[0.03]" />
        </div>
        <div className="flex flex-col gap-1.5 px-4 pt-3 pb-3.5">
          <p className="truncate text-[15px] font-medium text-ink">{page.title}</p>
          <div className="flex items-center gap-2 text-[13px] text-muted">
            <span
              className={
                "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-xs font-medium " +
                (live ? "bg-success/12 text-success" : "bg-hover text-muted")
              }
            >
              {live ? <span className="size-1.5 rounded-full bg-success" /> : null}
              {live ? `Live v${page.liveNumber}` : `Draft v${page.latestNumber}`}
            </span>
            {page.openThreads > 0 ? (
              <span className="inline-flex items-center gap-1 text-soft">
                <MessageSquare className="size-3.5" />
                {page.openThreads}
              </span>
            ) : null}
            <span className="ml-auto truncate">
              {page.isMine ? null : <>{page.ownerName} · </>}
              <time dateTime={page.touchedAt} title={new Date(page.touchedAt).toUTCString()}>
                {relativeTime(page.touchedAt, now)}
              </time>
            </span>
          </div>
        </div>
      </Link>
    </li>
  );
}
