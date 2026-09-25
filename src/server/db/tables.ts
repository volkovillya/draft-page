import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const pageVersionState = pgEnum("page_version_state", ["draft", "live"]);
export const pageVersionOrigin = pgEnum("page_version_origin", ["upload", "assistant"]);
export const messageAuthor = pgEnum("message_author", ["member", "assistant"]);

/** A person allowed to sign in. `id` is the Auth0 subject. Upserted on sign-in. */
export const members = pgTable("members", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  pictureUrl: text("picture_url"),
  joinedAt: ts("joined_at").defaultNow().notNull(),
  seenAt: ts("seen_at").defaultNow().notNull(),
});

/** An uploaded HTML page under review. Its content lives in page_versions. */
export const pages = pgTable("pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  shortId: text("short_id").notNull().unique(),
  title: text("title").notNull(),
  ownerMemberId: text("owner_member_id")
    .notNull()
    .references(() => members.id),
  createdAt: ts("created_at").defaultNow().notNull(),
  touchedAt: ts("touched_at").defaultNow().notNull(),
});

export const pageVersions = pgTable(
  "page_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    html: text("html").notNull(),
    state: pageVersionState("state").notNull().default("draft"),
    origin: pageVersionOrigin("origin").notNull(),
    basedOnVersionId: uuid("based_on_version_id"),
    createdByMemberId: text("created_by_member_id").references(() => members.id),
    createdAt: ts("created_at").defaultNow().notNull(),
    madeLiveAt: ts("made_live_at"),
    madeLiveByMemberId: text("made_live_by_member_id").references(() => members.id),
  },
  (t) => [
    uniqueIndex("page_versions_page_number_uq").on(t.pageId, t.number),
    // At most one live version per page, enforced by the database itself.
    uniqueIndex("page_versions_one_live_uq").on(t.pageId).where(sql`${t.state} = 'live'`),
    check(
      "page_versions_origin_author_ck",
      sql`(${t.origin} = 'assistant') = (${t.createdByMemberId} IS NULL)`,
    ),
  ],
);

/** A pinned conversation on a page, opened on a specific version. */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    openedOnVersionId: uuid("opened_on_version_id")
      .notNull()
      .references(() => pageVersions.id, { onDelete: "cascade" }),
    posX: real("pos_x").notNull(),
    posY: real("pos_y").notNull(),
    targetPath: text("target_path"),
    excerpt: text("excerpt"),
    claudeRequestedAt: ts("claude_requested_at"),
    closedAt: ts("closed_at"),
    closedByMemberId: text("closed_by_member_id").references(() => members.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("threads_page_closed_ix").on(t.pageId, t.closedAt),
    // Mirrors POS_MIN..POS_MAX in src/frame-bridge/range.ts.
    check("threads_pos_range_ck", sql`${t.posX} BETWEEN -1 AND 2 AND ${t.posY} BETWEEN -1 AND 2`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    authorKind: messageAuthor("author_kind").notNull(),
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("messages_thread_seq_uq").on(t.threadId, t.seq),
    check(
      "messages_author_ck",
      sql`${t.authorKind} = 'member' OR ${t.authorMemberId} IS NULL`,
    ),
  ],
);

export const aiJobKind = pgEnum("ai_job_kind", ["edit_page"]);
export const aiJobStatus = pgEnum("ai_job_status", ["pending", "processing", "completed", "failed"]);

/**
 * One "@Claude" request. Created with the thread in the same transaction; the worker then
 * moves it pending → processing → completed | failed. The unique key makes a job for the
 * same thread and base version impossible to create twice.
 */
export const aiJobs = pgTable(
  "ai_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: aiJobKind("kind").notNull().default("edit_page"),
    status: aiJobStatus("status").notNull().default("pending"),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    requestMessageId: uuid("request_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    baseVersionId: uuid("base_version_id")
      .notNull()
      .references(() => pageVersions.id, { onDelete: "cascade" }),
    resultVersionId: uuid("result_version_id").references(() => pageVersions.id, { onDelete: "set null" }),
    replyMessageId: uuid("reply_message_id").references(() => messages.id, { onDelete: "set null" }),
    provider: text("provider"),
    model: text("model"),
    attemptCount: integer("attempt_count").notNull().default(0),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: ts("created_at").defaultNow().notNull(),
    startedAt: ts("started_at"),
    completedAt: ts("completed_at"),
  },
  (t) => [
    uniqueIndex("ai_jobs_thread_base_kind_uq").on(t.threadId, t.baseVersionId, t.kind),
    index("ai_jobs_page_ix").on(t.pageId),
  ],
);

/**
 * One row per accepted "@Claude" request, for the daily AI limits. Kept apart from ai_jobs
 * on purpose: deleting a thread deletes its job, and must not give the allowance back.
 * job_id has no foreign key for the same reason.
 */
export const aiRequests = pgTable(
  "ai_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id),
    jobId: uuid("job_id").notNull(),
    // For the monthly AI budget: the most one attempt can cost, held until the real cost is
    // known. Each retry holds another; completion replaces the last attempt's hold with cost_usd.
    reservedUsd: numeric("reserved_usd", { precision: 10, scale: 6 }).notNull().default("0"),
    attempts: integer("attempts").notNull().default(1),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("ai_requests_created_ix").on(t.createdAt), index("ai_requests_job_ix").on(t.jobId)],
);

/**
 * Transactional outbox (§23): a row written in the same transaction as the change it
 * announces. The relay publishes undispatched rows to SQS and stamps dispatched_at, so a
 * crash between the commit and the publish loses nothing.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: text("topic").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
    availableAt: ts("available_at").defaultNow().notNull(),
    dispatchedAt: ts("dispatched_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (t) => [index("outbox_events_pending_ix").on(t.availableAt).where(sql`${t.dispatchedAt} IS NULL`)],
);

export type Member = typeof members.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type PageVersion = typeof pageVersions.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AiJob = typeof aiJobs.$inferSelect;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
