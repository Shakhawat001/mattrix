ALTER TABLE "apps" ADD COLUMN "ledger_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "transactions_watermark" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "transactions_error" text;