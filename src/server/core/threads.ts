import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/connection";
import { members, messages, pages, pageVersions, threads } from "../db/tables";
import { ASSISTANT_DISPLAY_NAME, type Actor } from "./actor";
import { enqueueEditJob, latestJobsByThread, type AiJobView } from "./ai-jobs";
import { parseClaudeRequest } from "./claude-trigger";
import { invalid, missing, notAllowed } from "./failures";
import { requireMember, requireText, requireUuid } from "./guards";
import { inPosRange, POS_MAX, POS_MIN } from "../../frame-bridge/range";

export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_EXCERPT_LENGTH = 500;
export const MAX_TARGET_PATH_LENGTH = 512;

export type MessageView = {
  id: string;
  seq: number;
  authorKind: "member" | "assistant";
  senderName: string;
  /** Assistant messages only: the person whose "@Claude" request this answers. */
  via: string | null;
  text: string;
  createdAt: string;
  canDelete: boolean;
};

export type ThreadView = {
  id: string;
  openedOnNumber: number;
  carried: boolean; // opened on an earlier version, still open
  posX: number;
  posY: number;
  targetPath: string | null;
  excerpt: string | null;
  claudeRequestedAt: string | null;
  /** The thread's newest AI job, when its opening message asked Claude for an edit. */
  aiJob: AiJobView | null;
  closedAt: string | null;
  canClose: boolean;
  messages: MessageView[];
};

export type OpenThreadInput = {
  versionId: string;
  posX: unknown;
  posY: unknown;
  targetPath?: unknown;
  excerpt?: unknown;
  text: unknown;
};

/** Starts a pinned thread on the newest version, with its opening message, atomically. */
export async function openThread(
  db: Db,
  actor: Actor,
  input: OpenThreadInput,
): Promise<{ threadId: string; claudeRequested: boolean }> {
  const member = requireMember(actor);
  const versionId = requireUuid(input.versionId, "Version");
  const posX = requireFraction(input.posX, "posX");
  const posY = requireFraction(input.posY, "posY");
  const text = requireText(input.text, "Message", 1, MAX_MESSAGE_LENGTH);
  const targetPath = optionalText(input.targetPath, MAX_TARGET_PATH_LENGTH);
  const excerpt = optionalText(input.excerpt, MAX_EXCERPT_LENGTH, true);
  const claude = parseClaudeRequest(text);

  return db.transaction(async (tx) => {
    const version = await tx.query.pageVersions.findFirst({
      where: eq(pageVersions.id, versionId),
      columns: { id: true, pageId: true, number: true },
    });
    if (!version) throw missing("Version");
    // Share-lock the page so a concurrent addVersion (which takes FOR UPDATE) can't slip in
    // between the "is this the newest version" check and the insert.
    await tx.select({ id: pages.id }).from(pages).where(eq(pages.id, version.pageId)).for("share");
    const [{ newest }] = (await tx
      .select({ newest: sql<number>`max(${pageVersions.number})::int` })
      .from(pageVersions)
      .where(eq(pageVersions.pageId, version.pageId))) as [{ newest: number }];
    if (version.number !== newest) throw invalid("Comments can only be added to the newest version");

    const [thread] = await tx
      .insert(threads)
      .values({
        pageId: version.pageId,
        openedOnVersionId: version.id,
        posX,
        posY,
        targetPath,
        excerpt,
        claudeRequestedAt: claude.requested ? sql`now()` : null,
      })
      .returning({ id: threads.id });
    const [opening] = await tx
      .insert(messages)
      .values({
        threadId: thread!.id,
        seq: 1,
        authorKind: "member",
        authorMemberId: member.memberId,
        text,
      })
      .returning({ id: messages.id });
    // The AI job and its outbox event commit with the thread, or not at all (§23).
    if (claude.requested) {
      await enqueueEditJob(tx, {
        pageId: version.pageId,
        threadId: thread!.id,
        requestMessageId: opening!.id,
        baseVersionId: version.id,
      });
    }
    return { threadId: thread!.id, claudeRequested: claude.requested };
  });
}

/** Appends a message. Members may reply to open threads; the assistant only to its job's thread. */
export async function postMessage(
  db: Db,
  actor: Actor,
  input: { threadId: string; text: unknown },
): Promise<{ messageId: string; seq: number }> {
  const threadId = requireUuid(input.threadId, "Thread");
  const text = requireText(input.text, "Message", 1, MAX_MESSAGE_LENGTH);
  if (actor.kind === "assistant" && actor.threadId !== threadId) {
    throw notAllowed("The assistant can only reply in its job's thread");
  }

  return db.transaction((tx) => appendMessage(tx, actor, { threadId, text }));
}

/** The body of postMessage, for callers that already hold a transaction (completing an AI job). */
export async function appendMessage(
  tx: Tx,
  actor: Actor,
  input: { threadId: string; text: string },
): Promise<{ messageId: string; seq: number }> {
  const { threadId, text } = input;
  if (actor.kind === "assistant" && actor.threadId !== threadId) {
    throw notAllowed("The assistant can only reply in its job's thread");
  }
  const [thread] = await tx.select().from(threads).where(eq(threads.id, threadId)).for("update");
  if (!thread) throw missing("Thread");
  if (thread.closedAt) throw invalid("This thread is resolved; reopen it to reply");

  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${messages.seq}), 0)::int + 1` })
    .from(messages)
    .where(eq(messages.threadId, threadId))) as [{ next: number }];

  const [created] = await tx
    .insert(messages)
    .values({
      threadId,
      seq: next,
      authorKind: actor.kind === "member" ? "member" : "assistant",
      authorMemberId: actor.kind === "member" ? actor.memberId : null,
      text,
    })
    .returning({ id: messages.id, seq: messages.seq });
  return { messageId: created!.id, seq: created!.seq };
}

export async function closeThread(db: Db, actor: Actor, threadId: string): Promise<void> {
  await setClosed(db, actor, threadId, true);
}

export async function reopenThread(db: Db, actor: Actor, threadId: string): Promise<void> {
  await setClosed(db, actor, threadId, false);
}

async function setClosed(db: Db, actor: Actor, threadId: string, close: boolean): Promise<void> {
  // The assistant never resolves: refused before any database access.
  const member = requireMember(actor);
  requireUuid(threadId, "Thread");
  const ctx = await loadThreadContext(db, threadId);
  if (ctx.ownerMemberId !== member.memberId && ctx.openerMemberId !== member.memberId) {
    throw notAllowed("Only the thread's author or the page owner can resolve it");
  }
  await db
    .update(threads)
    .set(
      close
        ? { closedAt: sql`now()`, closedByMemberId: member.memberId }
        : { closedAt: null, closedByMemberId: null },
    )
    .where(eq(threads.id, threadId));
}

/** Deletes a message; deleting the opening message deletes the whole thread. */
export async function deleteMessage(db: Db, actor: Actor, messageId: string): Promise<void> {
  const member = requireMember(actor);
  requireUuid(messageId, "Message");
  const message = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!message) throw missing("Message");
  const ctx = await loadThreadContext(db, message.threadId);
  if (message.authorMemberId !== member.memberId && ctx.ownerMemberId !== member.memberId) {
    throw notAllowed("Only the author or the page owner can delete this");
  }
  if (message.seq === 1) await db.delete(threads).where(eq(threads.id, message.threadId));
  else await db.delete(messages).where(eq(messages.id, messageId));
}

/**
 * Threads visible on a version: those opened on it, plus threads still open that
 * were opened on an earlier version (carried forward). Oldest first.
 */
export async function listThreads(db: Db, actor: Actor, versionId: string): Promise<ThreadView[]> {
  const member = requireMember(actor);
  requireUuid(versionId, "Version");
  const version = await db.query.pageVersions.findFirst({
    where: eq(pageVersions.id, versionId),
    columns: { id: true, pageId: true, number: true },
  });
  if (!version) throw missing("Version");
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, version.pageId),
    columns: { ownerMemberId: true },
  });
  const isOwner = page?.ownerMemberId === member.memberId;

  const rows = await db
    .select({ thread: threads, openedOnNumber: pageVersions.number })
    .from(threads)
    .innerJoin(pageVersions, eq(pageVersions.id, threads.openedOnVersionId))
    .where(
      and(
        eq(threads.pageId, version.pageId),
        or(
          eq(threads.openedOnVersionId, version.id),
          and(isNull(threads.closedAt), lt(pageVersions.number, version.number)),
        ),
      ),
    )
    .orderBy(asc(threads.createdAt), asc(threads.id)); // oldest first: thread #1 is the first opened
  if (rows.length === 0) return [];

  const threadIds = rows.map((r) => r.thread.id);
  const jobs = await latestJobsByThread(db, threadIds);
  const msgRows = await db
    .select({ message: messages, senderName: members.name })
    .from(messages)
    .leftJoin(members, eq(members.id, messages.authorMemberId))
    .where(
      inArray(messages.threadId, threadIds),
    )
    .orderBy(asc(messages.seq));

  const byThread = new Map<string, MessageView[]>();
  const openerOf = new Map<string, string | null>();
  const openerNameOf = new Map<string, string>();
  for (const { message, senderName } of msgRows) {
    if (message.seq !== 1) continue;
    openerOf.set(message.threadId, message.authorMemberId);
    openerNameOf.set(message.threadId, senderName ?? "Former member");
  }
  for (const { message, senderName } of msgRows) {
    const list = byThread.get(message.threadId) ?? [];
    list.push({
      id: message.id,
      seq: message.seq,
      authorKind: message.authorKind,
      senderName:
        message.authorKind === "assistant" ? ASSISTANT_DISPLAY_NAME : (senderName ?? "Former member"),
      via: message.authorKind === "assistant" ? (openerNameOf.get(message.threadId) ?? null) : null,
      text: message.text,
      createdAt: message.createdAt.toISOString(),
      canDelete: isOwner || message.authorMemberId === member.memberId,
    });
    byThread.set(message.threadId, list);
  }

  return rows.map(({ thread, openedOnNumber }) => ({
    id: thread.id,
    openedOnNumber,
    carried: thread.openedOnVersionId !== version.id,
    posX: thread.posX,
    posY: thread.posY,
    targetPath: thread.targetPath,
    excerpt: thread.excerpt,
    claudeRequestedAt: thread.claudeRequestedAt?.toISOString() ?? null,
    aiJob: jobs.get(thread.id) ?? null,
    closedAt: thread.closedAt?.toISOString() ?? null,
    canClose: isOwner || openerOf.get(thread.id) === member.memberId,
    messages: byThread.get(thread.id) ?? [],
  }));
}

async function loadThreadContext(db: Db, threadId: string) {
  const [row] = await db
    .select({ ownerMemberId: pages.ownerMemberId })
    .from(threads)
    .innerJoin(pages, eq(pages.id, threads.pageId))
    .where(eq(threads.id, threadId));
  if (!row) throw missing("Thread");
  const opener = await db.query.messages.findFirst({
    where: and(eq(messages.threadId, threadId), eq(messages.seq, 1)),
    columns: { authorMemberId: true },
  });
  return { ownerMemberId: row.ownerMemberId, openerMemberId: opener?.authorMemberId ?? null };
}

function requireFraction(value: unknown, what: string): number {
  if (!inPosRange(value)) throw invalid(`${what} must be a number between ${POS_MIN} and ${POS_MAX}`);
  return value;
}

function optionalText(value: unknown, max: number, truncate = false): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid("Expected text");
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    if (truncate) return trimmed.slice(0, max);
    throw invalid(`Value is too long (max ${max} characters)`);
  }
  return trimmed;
}
