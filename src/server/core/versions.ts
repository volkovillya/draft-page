import { and, eq, ne, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/connection";
import { pages, pageVersions } from "../db/tables";
import type { Actor } from "./actor";
import { invalid, missing, notAllowed } from "./failures";
import { requireHtml, requireMember, requireUuid } from "./guards";

export type AddedVersion = { versionId: string; number: number };

/**
 * Appends a new draft version. Allowed for the page owner, or for the assistant
 * running a job on this page. Version numbers are allocated under a row lock on
 * the page, so concurrent calls never collide.
 */
export async function addVersion(
  db: Db,
  actor: Actor,
  input: { shortId?: string; pageId?: string; html: unknown; basedOnVersionId?: string | null },
): Promise<AddedVersion> {
  const html = requireHtml(input.html);
  return db.transaction((tx) => appendVersion(tx, actor, { ...input, html }));
}

/** The body of addVersion, for callers that already hold a transaction (completing an AI job). */
export async function appendVersion(
  tx: Tx,
  actor: Actor,
  input: { shortId?: string; pageId?: string; html: string; basedOnVersionId?: string | null },
): Promise<AddedVersion> {
  const html = requireHtml(input.html);
  const where = input.pageId
    ? eq(pages.id, requireUuid(input.pageId, "Page"))
    : eq(pages.shortId, input.shortId ?? "");
  const [page] = await tx.select().from(pages).where(where).for("update");
  if (!page) throw missing("Page");

  if (actor.kind === "member") {
    if (page.ownerMemberId !== actor.memberId) {
      throw notAllowed("Only the owner can add versions");
    }
  } else if (actor.pageId !== page.id) {
    throw notAllowed("The assistant can only edit the page its job belongs to");
  }

  if (input.basedOnVersionId) {
    const base = await tx.query.pageVersions.findFirst({
      where: eq(pageVersions.id, requireUuid(input.basedOnVersionId, "Base version")),
      columns: { pageId: true },
    });
    if (!base || base.pageId !== page.id) throw invalid("Base version must belong to this page");
  }

  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${pageVersions.number}), 0)::int + 1` })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, page.id))) as [{ next: number }];

  const [created] = await tx
    .insert(pageVersions)
    .values({
      pageId: page.id,
      number: next,
      html,
      state: "draft",
      origin: actor.kind === "member" ? "upload" : "assistant",
      basedOnVersionId: input.basedOnVersionId ?? null,
      createdByMemberId: actor.kind === "member" ? actor.memberId : null,
    })
    .returning({ id: pageVersions.id, number: pageVersions.number });

  await tx.update(pages).set({ touchedAt: sql`now()` }).where(eq(pages.id, page.id));
  return { versionId: created!.id, number: created!.number };
}

/** Makes one version live and demotes any other live version of the same page. Humans only. */
export async function publishVersion(db: Db, actor: Actor, versionId: string): Promise<void> {
  const member = requireMember(actor);
  requireUuid(versionId, "Version");

  await db.transaction(async (tx) => {
    const target = await lockOwnedVersion(tx, member.memberId, versionId);
    if (target.state === "live") return;
    await tx
      .update(pageVersions)
      .set({ state: "draft" })
      .where(
        and(
          eq(pageVersions.pageId, target.pageId),
          eq(pageVersions.state, "live"),
          ne(pageVersions.id, versionId),
        ),
      );
    await tx
      .update(pageVersions)
      .set({ state: "live", madeLiveAt: sql`now()`, madeLiveByMemberId: member.memberId })
      .where(eq(pageVersions.id, versionId));
    await tx.update(pages).set({ touchedAt: sql`now()` }).where(eq(pages.id, target.pageId));
  });
}

export async function unpublishVersion(db: Db, actor: Actor, versionId: string): Promise<void> {
  const member = requireMember(actor);
  requireUuid(versionId, "Version");

  await db.transaction(async (tx) => {
    const version = await lockOwnedVersion(tx, member.memberId, versionId);
    await tx.update(pageVersions).set({ state: "draft" }).where(eq(pageVersions.id, versionId));
    await tx.update(pages).set({ touchedAt: sql`now()` }).where(eq(pages.id, version.pageId));
  });
}

/**
 * Deletes one draft version. Owner only (the assistant never deletes). Never the live version
 * (unpublish it first) and never the last one (delete the page instead). Threads opened on it
 * are deleted with it. The remaining versions keep their numbers (only a deleted newest number
 * can be given again, to the next version).
 */
export async function deleteVersion(db: Db, actor: Actor, versionId: string): Promise<void> {
  const member = requireMember(actor);
  requireUuid(versionId, "Version");

  await db.transaction(async (tx) => {
    const version = await lockOwnedVersion(tx, member.memberId, versionId, "delete versions");
    if (version.state === "live") throw invalid("Unpublish this version before deleting it");
    const [{ count }] = (await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(pageVersions)
      .where(eq(pageVersions.pageId, version.pageId))) as [{ count: number }];
    if (count <= 1) throw invalid("This is the page's only version; delete the page instead");
    await tx.delete(pageVersions).where(eq(pageVersions.id, versionId));
    await tx.update(pages).set({ touchedAt: sql`now()` }).where(eq(pages.id, version.pageId));
  });
}

/** Raw HTML of a version, for the sandboxed frame (members) or the worker (its own page). */
export async function getVersionHtml(
  db: Db,
  actor: Actor,
  versionId: string,
): Promise<{ html: string; pageId: string; number: number }> {
  requireUuid(versionId, "Version");
  const version = await db.query.pageVersions.findFirst({
    where: eq(pageVersions.id, versionId),
    columns: { html: true, pageId: true, number: true },
  });
  if (!version) throw missing("Version");
  if (actor.kind === "assistant" && actor.pageId !== version.pageId) {
    throw notAllowed("The assistant can only read the page its job belongs to");
  }
  return version;
}


// Locks the page row first (same order as addVersion) to avoid deadlocks.
async function lockOwnedVersion(tx: Tx, memberId: string, versionId: string, action = "publish") {
  const version = await tx.query.pageVersions.findFirst({
    where: eq(pageVersions.id, versionId),
    columns: { id: true, pageId: true, state: true },
  });
  if (!version) throw missing("Version");
  const [page] = await tx.select().from(pages).where(eq(pages.id, version.pageId)).for("update");
  if (!page) throw missing("Page");
  if (page.ownerMemberId !== memberId) throw notAllowed(`Only the owner can ${action}`);
  return version;
}
