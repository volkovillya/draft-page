import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AssistantActor, MemberActor } from "@/server/core/actor";
import { createPage } from "@/server/core/pages";
import { createDb, type Db } from "@/server/db/connection";
import { members } from "@/server/db/tables";
import { TEST_DATABASE_URL } from "./env";

let handle: { db: Db; close: () => Promise<void> } | undefined;

/** One pool per test file. Large enough that concurrency tests really run in parallel. */
export function testDb(): Db {
  handle ??= createDb(TEST_DATABASE_URL, { max: 12 });
  return handle.db;
}

export async function closeTestDb(): Promise<void> {
  await handle?.close();
  handle = undefined;
}

export async function reset(): Promise<void> {
  await testDb().execute(
    sql`TRUNCATE TABLE messages, threads, page_versions, pages, members RESTART IDENTITY CASCADE`,
  );
}

let counter = 0;

export async function makeMember(overrides: Partial<Omit<MemberActor, "kind">> = {}): Promise<MemberActor> {
  counter += 1;
  const memberId = overrides.memberId ?? `auth0|test-${counter}-${randomUUID().slice(0, 8)}`;
  const email = overrides.email ?? `member${counter}-${randomUUID().slice(0, 8)}@example.com`;
  const name = overrides.name ?? `Member ${counter}`;
  await testDb().insert(members).values({ id: memberId, email, name });
  return { kind: "member", memberId, email, name };
}

export type MadePage = { id: string; shortId: string; versionId: string };

export async function makePage(
  owner: MemberActor,
  html = "<!doctype html><html><body><h1>Hello</h1></body></html>",
  title = "Test page",
): Promise<MadePage> {
  const db = testDb();
  const created = await createPage(db, owner, { title, html });
  const page = await db.query.pages.findFirst({
    where: (p, { eq }) => eq(p.shortId, created.shortId),
    columns: { id: true },
  });
  return { id: page!.id, shortId: created.shortId, versionId: created.versionId };
}

export function assistantActor(overrides: Partial<Omit<AssistantActor, "kind">> = {}): AssistantActor {
  return {
    kind: "assistant",
    jobId: overrides.jobId ?? randomUUID(),
    pageId: overrides.pageId ?? randomUUID(),
    threadId: overrides.threadId ?? randomUUID(),
  };
}

/** Awaits a promise expected to reject with a core `Failure` and returns its code. */
export async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && (error as Error).name === "Failure") return code;
    throw error;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}
