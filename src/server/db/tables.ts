import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
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

export type Member = typeof members.$inferSelect;
export type Page = typeof pages.$inferSelect;
export type PageVersion = typeof pageVersions.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Message = typeof messages.$inferSelect;
