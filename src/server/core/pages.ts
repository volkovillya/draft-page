import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/connection";
import { members, pages, pageVersions } from "../db/tables";
import type { Actor } from "./actor";
import { conflict, missing, notAllowed } from "./failures";
import { requireHtml, requireMember, requireText } from "./guards";
import { newShortId } from "./ids";

export const MAX_TITLE_LENGTH = 200;

export type PageSummary = {
  shortId: string;
  title: string;
  ownerName: string;
  isMine: boolean;
  versionCount: number;
  latestNumber: number;
  liveNumber: number | null;
  openThreads: number;
  touchedAt: string;
  /** The version a thumbnail should show: the live one, else the newest. */
  previewVersionId: string;
};

export type VersionSummary = {
  id: string;
  number: number;
  state: "draft" | "live";
  origin: "upload" | "assistant";
  createdAt: string;
};

export type PageDetail = {
  id: string;
  shortId: string;
  title: string;
  ownerName: string;
  isOwner: boolean;
  versions: VersionSummary[]; // newest first
};

export async function createPage(
  db: Db,
  actor: Actor,
  input: { title: unknown; html: unknown },
): Promise<{ shortId: string; versionId: string; versionNumber: number }> {
  const member = requireMember(actor);
  const title = requireText(input.title, "Title", 1, MAX_TITLE_LENGTH);
  const html = requireHtml(input.html);

  for (let attempt = 0; attempt < 5; attempt++) {
    const shortId = newShortId();
    try {
      return await db.transaction(async (tx) => {
        const [page] = await tx
          .insert(pages)
          .values({ shortId, title, ownerMemberId: member.memberId })
          .returning({ id: pages.id });
        const [version] = await tx
          .insert(pageVersions)
          .values({
            pageId: page!.id,
            number: 1,
            html,
            origin: "upload",
            createdByMemberId: member.memberId,
          })
          .returning({ id: pageVersions.id });
        return { shortId, versionId: version!.id, versionNumber: 1 };
      });
    } catch (error) {
      if (isUniqueViolation(error, "pages_short_id_unique")) continue;
      throw error;
    }
  }
  throw conflict("Could not allocate a page id, try again");
}

export const MAX_LIST_LIMIT = 100;

/** Pages for the gallery: mine first, each group by newest activity. Paged with limit/offset. */
export async function listPages(
  db: Db,
  actor: Actor,
  { limit = MAX_LIST_LIMIT, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<PageSummary[]> {
  const member = requireMember(actor);
  const take = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST_LIMIT);
  const skip = Math.max(0, Math.floor(offset));
  const rows = await db
    .select({
      shortId: pages.shortId,
      title: pages.title,
      ownerMemberId: pages.ownerMemberId,
      ownerName: members.name,
      touchedAt: pages.touchedAt,
      versionCount: sql<number>`(select count(*)::int from page_versions v where v.page_id = ${pages.id})`,
      latestNumber: sql<number>`(select coalesce(max(v.number), 0)::int from page_versions v where v.page_id = ${pages.id})`,
      liveNumber: sql<number | null>`(select v.number from page_versions v where v.page_id = ${pages.id} and v.state = 'live')`,
      openThreads: sql<number>`(select count(*)::int from threads t where t.page_id = ${pages.id} and t.closed_at is null)`,
      previewVersionId: sql<string>`(select v.id from page_versions v where v.page_id = ${pages.id} order by (v.state = 'live') desc, v.number desc limit 1)`,
    })
    .from(pages)
    .innerJoin(members, eq(members.id, pages.ownerMemberId))
    .orderBy(desc(sql`${pages.ownerMemberId} = ${member.memberId}`), desc(pages.touchedAt), desc(pages.id))
    .limit(take)
    .offset(skip);

  return rows.map((r) => ({
    shortId: r.shortId,
    title: r.title,
    ownerName: r.ownerName,
    isMine: r.ownerMemberId === member.memberId,
    versionCount: Number(r.versionCount),
    latestNumber: Number(r.latestNumber),
    liveNumber: r.liveNumber === null ? null : Number(r.liveNumber),
    openThreads: Number(r.openThreads),
    touchedAt: r.touchedAt.toISOString(),
    previewVersionId: r.previewVersionId,
  }));
}

/** How many pages the member owns and how many belong to others (for paging the gallery). */
export async function countPages(db: Db, actor: Actor): Promise<{ mine: number; shared: number }> {
  const member = requireMember(actor);
  const [row] = await db
    .select({
      mine: sql<number>`count(*) filter (where ${pages.ownerMemberId} = ${member.memberId})::int`,
      shared: sql<number>`count(*) filter (where ${pages.ownerMemberId} <> ${member.memberId})::int`,
    })
    .from(pages);
  return { mine: Number(row?.mine ?? 0), shared: Number(row?.shared ?? 0) };
}

export async function getPage(db: Db, actor: Actor, shortId: string): Promise<PageDetail> {
  const member = requireMember(actor);
  const [row] = await db
    .select({
      id: pages.id,
      shortId: pages.shortId,
      title: pages.title,
      ownerMemberId: pages.ownerMemberId,
      ownerName: members.name,
    })
    .from(pages)
    .innerJoin(members, eq(members.id, pages.ownerMemberId))
    .where(eq(pages.shortId, shortId));
  if (!row) throw missing("Page");

  const versions = await db
    .select({
      id: pageVersions.id,
      number: pageVersions.number,
      state: pageVersions.state,
      origin: pageVersions.origin,
      createdAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, row.id))
    .orderBy(desc(pageVersions.number));

  return {
    id: row.id,
    shortId: row.shortId,
    title: row.title,
    ownerName: row.ownerName,
    isOwner: row.ownerMemberId === member.memberId,
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}

/** The version to show when none is requested: the live one, else the newest. */
export function defaultVersion(detail: PageDetail): VersionSummary {
  return detail.versions.find((v) => v.state === "live") ?? detail.versions[0]!;
}

export async function deletePage(db: Db, actor: Actor, shortId: string): Promise<void> {
  const member = requireMember(actor);
  const page = await db.query.pages.findFirst({ where: eq(pages.shortId, shortId) });
  if (!page) throw missing("Page");
  if (page.ownerMemberId !== member.memberId) throw notAllowed("Only the owner can delete this page");
  await db.delete(pages).where(eq(pages.id, page.id));
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  // Drizzle wraps driver errors; the Postgres error is on `cause`.
  const pg = (error as { cause?: unknown })?.cause ?? error;
  const e = pg as { code?: string; constraint_name?: string; constraint?: string };
  if (e?.code !== "23505") return false;
  return !constraint || e.constraint_name === constraint || e.constraint === constraint;
}
