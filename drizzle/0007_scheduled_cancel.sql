ALTER TABLE "subscriptions" ADD COLUMN "cancel_scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "cancel_effective_at" timestamp with time zone;