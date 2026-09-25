ALTER TABLE "ai_requests" ADD COLUMN "reserved_usd" numeric(10, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_requests" ADD COLUMN "cost_usd" numeric(10, 6);--> statement-breakpoint
CREATE INDEX "ai_requests_job_ix" ON "ai_requests" USING btree ("job_id");