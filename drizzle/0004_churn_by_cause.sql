ALTER TABLE "daily_metrics" ADD COLUMN "deactivations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "reactivations" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "uninstalls_store_inactive" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "canceled_subs_store_inactive" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD COLUMN "churned_mrr_store_inactive_cents" bigint DEFAULT 0 NOT NULL;