ALTER TABLE "connections" ADD COLUMN "legacy_watermark" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "legacy_error" text;