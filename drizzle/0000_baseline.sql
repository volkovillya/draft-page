CREATE TYPE "public"."message_author" AS ENUM('member', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."page_version_origin" AS ENUM('upload', 'assistant');--> statement-breakpoint
CREATE TYPE "public"."page_version_state" AS ENUM('draft', 'live');--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"picture_url" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author_kind" "message_author" NOT NULL,
	"author_member_id" text,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_author_ck" CHECK ("messages"."author_kind" = 'member' OR "messages"."author_member_id" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"html" text NOT NULL,
	"state" "page_version_state" DEFAULT 'draft' NOT NULL,
	"origin" "page_version_origin" NOT NULL,
	"based_on_version_id" uuid,
	"created_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"made_live_at" timestamp with time zone,
	"made_live_by_member_id" text,
	CONSTRAINT "page_versions_origin_author_ck" CHECK (("page_versions"."origin" = 'assistant') = ("page_versions"."created_by_member_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"short_id" text NOT NULL,
	"title" text NOT NULL,
	"owner_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pages_short_id_unique" UNIQUE("short_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"opened_on_version_id" uuid NOT NULL,
	"pos_x" real NOT NULL,
	"pos_y" real NOT NULL,
	"target_path" text,
	"excerpt" text,
	"claude_requested_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_pos_range_ck" CHECK ("threads"."pos_x" BETWEEN 0 AND 1 AND "threads"."pos_y" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_created_by_member_id_members_id_fk" FOREIGN KEY ("created_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_versions" ADD CONSTRAINT "page_versions_made_live_by_member_id_members_id_fk" FOREIGN KEY ("made_live_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_owner_member_id_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_opened_on_version_id_page_versions_id_fk" FOREIGN KEY ("opened_on_version_id") REFERENCES "public"."page_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_closed_by_member_id_members_id_fk" FOREIGN KEY ("closed_by_member_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_thread_seq_uq" ON "messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_page_number_uq" ON "page_versions" USING btree ("page_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "page_versions_one_live_uq" ON "page_versions" USING btree ("page_id") WHERE "page_versions"."state" = 'live';--> statement-breakpoint
CREATE INDEX "threads_page_closed_ix" ON "threads" USING btree ("page_id","closed_at");