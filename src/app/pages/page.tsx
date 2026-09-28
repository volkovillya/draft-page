import type { Metadata } from "next";
import { ChevronLeft, ChevronRight, Plus, Upload } from "lucide-react";
import { Suspense } from "react";
import { getDb } from "@/server/db/connection";
import type { MemberActor } from "@/server/core/actor";
import { countPages, listPages, type PageSummary } from "@/server/core/pages";
import { AppHeader } from "@/ui/common/AppHeader";
import { ButtonLink } from "@/ui/common/Button";
import { RefreshOnHistoryReturn } from "@/ui/common/refresh-on-return";
import { requireMemberPage } from "@/ui/common/require-member-page";
import { PageCard } from "@/ui/pages/PageCard";

export const metadata: Metadata = { title: "Pages" };

const PAGE_SIZE = 24;

export default async function PagesListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [actor, query] = await Promise.all([requireMemberPage(), searchParams]);
  const raw = Array.isArray(query.p) ? query.p[0] : query.p;
  const pageNumber = raw && /^\d{1,6}$/.test(raw) ? Math.max(1, Number(raw)) : 1;
  return (
    <>
      <AppHeader memberName={actor.name}>
        <ButtonLink href="/pages/new" variant="inverse" size="sm">
          <Plus />
          New page
        </ButtonLink>
      </AppHeader>
      <main className="mx-auto max-w-6xl px-4 pt-10 pb-20 sm:px-6">
        <h1 className="font-serif text-[34px] font-medium tracking-[-0.01em] text-ink">Pages</h1>
        <p className="mt-1.5 text-[15px] text-soft">Everything under review, newest activity first.</p>
        <Suspense key={pageNumber} fallback={<GridSkeleton />}>
          <PageLists actor={actor} pageNumber={pageNumber} />
        </Suspense>
        <RefreshOnHistoryReturn />
      </main>
    </>
  );
}

async function PageLists({ actor, pageNumber }: { actor: MemberActor; pageNumber: number }) {
  const db = getDb();
  const [items, counts] = await Promise.all([
    listPages(db, actor, { limit: PAGE_SIZE, offset: (pageNumber - 1) * PAGE_SIZE }),
    countPages(db, actor),
  ]);
  const total = counts.mine + counts.shared;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const mine: PageSummary[] = [];
  const shared: PageSummary[] = [];
  for (const p of items) (p.isMine ? mine : shared).push(p);
  const now = Date.now();

  if (total === 0) return <EmptyState />;
  return (
    <div className="mt-8 flex flex-col gap-12">
      {mine.length > 0 ? <Grid title="Your pages" count={counts.mine} pages={mine} now={now} /> : null}
      {shared.length > 0 ? <Grid title="Shared with you" count={counts.shared} pages={shared} now={now} /> : null}
      {items.length === 0 ? (
        <p className="text-sm text-soft">
          There&apos;s nothing on page {pageNumber}. <a href="/pages" className="text-marker hover:underline">Go to the first page</a>
        </p>
      ) : null}
      {pageCount > 1 ? <Pager current={pageNumber} count={pageCount} /> : null}
    </div>
  );
}

function Pager({ current, count }: { current: number; count: number }) {
  const href = (n: number) => (n === 1 ? "/pages" : `/pages?p=${n}`);
  return (
    <nav aria-label="Pagination" className="flex items-center justify-center gap-3 text-sm text-soft">
      {current > 1 ? (
        <ButtonLink href={href(current - 1)} variant="ghost" size="sm">
          <ChevronLeft />
          Newer
        </ButtonLink>
      ) : null}
      <span className="tabular-nums">
        Page {Math.min(current, count)} of {count}
      </span>
      {current < count ? (
        <ButtonLink href={href(current + 1)} variant="ghost" size="sm">
          Older
          <ChevronRight />
        </ButtonLink>
      ) : null}
    </nav>
  );
}

function Grid({ title, count, pages, now }: { title: string; count: number; pages: PageSummary[]; now: number }) {
  const id = `${title.replace(/\W+/g, "-").toLowerCase()}-heading`;
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="mb-4 flex items-baseline gap-2 text-sm font-medium text-soft">
        {title}
        <span className="text-muted">{count}</span>
      </h2>
      <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((p) => (
          <PageCard key={p.shortId} page={p} now={now} />
        ))}
      </ul>
    </section>
  );
}

function EmptyState() {
  return (
    <div className="mt-10 flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-hover text-soft">
        <Upload className="size-5" />
      </div>
      <h2 className="mt-4 font-serif text-xl font-medium">No pages yet</h2>
      <p className="mt-1.5 max-w-sm text-sm text-soft">
        Upload a self-contained HTML file to start a review. Reviewers pin comments right on the rendered page.
      </p>
      <ButtonLink href="/pages/new" variant="inverse" className="mt-6">
        <Plus />
        Upload a page
      </ButtonLink>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-busy="true" aria-label="Loading pages">
      {[0, 1, 2].map((i) => (
        <div key={i} className="overflow-hidden rounded-xl bg-panel ring-1 ring-line">
          <div className="aspect-[16/10] animate-pulse bg-hover" />
          <div className="space-y-2 p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-hover" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-hover" />
          </div>
        </div>
      ))}
    </div>
  );
}
