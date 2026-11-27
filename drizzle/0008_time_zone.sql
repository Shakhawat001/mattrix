CREATE TABLE "settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"time_zone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_one_row" CHECK ("settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "derived_time_zone" text;--> statement-breakpoint
-- Everything built before this was built in UTC, the only zone there was, so it needs no rebuild.
UPDATE "apps" SET "derived_time_zone" = 'UTC' WHERE "derived_at" IS NOT NULL;
