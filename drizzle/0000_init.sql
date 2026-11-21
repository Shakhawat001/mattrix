CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"gid" text NOT NULL,
	"api_key" text,
	"name" text NOT NULL,
	"display_name" text,
	"color" text,
	"hidden" boolean DEFAULT false NOT NULL,
	"first_event_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"dirty" boolean DEFAULT true NOT NULL,
	"derived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"partner_id" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_hint" text NOT NULL,
	"api_version" text DEFAULT '2026-07' NOT NULL,
	"app_gids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"backfill_from" timestamp with time zone NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"sync_requested_at" timestamp with time zone,
	"core_watermark" timestamp with time zone,
	"earnings_watermark" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"earnings_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_metrics" (
	"app_id" uuid NOT NULL,
	"date" date NOT NULL,
	"installs" integer DEFAULT 0 NOT NULL,
	"reinstalls" integer DEFAULT 0 NOT NULL,
	"uninstalls" integer DEFAULT 0 NOT NULL,
	"new_subs" integer DEFAULT 0 NOT NULL,
	"canceled_subs" integer DEFAULT 0 NOT NULL,
	"trials_started" integer DEFAULT 0 NOT NULL,
	"trials_converted" integer DEFAULT 0 NOT NULL,
	"trials_canceled" integer DEFAULT 0 NOT NULL,
	"new_mrr_cents" bigint DEFAULT 0 NOT NULL,
	"expansion_mrr_cents" bigint DEFAULT 0 NOT NULL,
	"contraction_mrr_cents" bigint DEFAULT 0 NOT NULL,
	"churned_mrr_cents" bigint DEFAULT 0 NOT NULL,
	"charged_cents" bigint DEFAULT 0 NOT NULL,
	"gross_earned_cents" bigint DEFAULT 0 NOT NULL,
	"net_earned_cents" bigint DEFAULT 0 NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"refunded_cents" bigint DEFAULT 0 NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"active_installs" integer DEFAULT 0 NOT NULL,
	"active_subs" integer DEFAULT 0 NOT NULL,
	"trial_subs" integer DEFAULT 0 NOT NULL,
	"mrr_cents" bigint DEFAULT 0 NOT NULL,
	"trial_mrr_cents" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_metrics_app_id_date_pk" PRIMARY KEY("app_id","date")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" uuid NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"shop" text,
	"shop_gid" text,
	"state" text,
	"reason" text,
	"reason_description" text,
	"plan_handle" text,
	"billing_period" text,
	"trial_days" integer,
	"trial_days_remaining" integer,
	"cancel_effective_on" timestamp with time zone,
	"amount_cents" bigint,
	"currency" text,
	"gross_cents" bigint,
	"net_cents" bigint,
	"fee_cents" bigint,
	"charge_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"shop" text NOT NULL,
	"seq" integer NOT NULL,
	"installed_at" timestamp with time zone NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"reason" text,
	"reason_description" text
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"shop" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"kind" text NOT NULL,
	"monthly_cents" bigint NOT NULL,
	"previous_monthly_cents" bigint,
	"plan_handle" text,
	"billing_period" text,
	"trial_ends_at" timestamp with time zone,
	"converted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"events_inserted" integer DEFAULT 0 NOT NULL,
	"apps_found" integer DEFAULT 0 NOT NULL,
	"error" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"shop" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"trial_days" integer NOT NULL,
	"resolved_at" timestamp with time zone,
	"outcome" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_metrics" ADD CONSTRAINT "daily_metrics_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trials" ADD CONSTRAINT "trials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apps_connection_gid_uq" ON "apps" USING btree ("connection_id","gid");--> statement-breakpoint
CREATE INDEX "events_app_time_idx" ON "events" USING btree ("app_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_app_type_time_idx" ON "events" USING btree ("app_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_app_shop_time_idx" ON "events" USING btree ("app_id","shop","occurred_at");--> statement-breakpoint
CREATE INDEX "installs_app_installed_idx" ON "installs" USING btree ("app_id","installed_at");--> statement-breakpoint
CREATE INDEX "installs_app_uninstalled_idx" ON "installs" USING btree ("app_id","uninstalled_at");--> statement-breakpoint
CREATE INDEX "installs_app_shop_idx" ON "installs" USING btree ("app_id","shop");--> statement-breakpoint
CREATE INDEX "login_attempts_key_at_idx" ON "login_attempts" USING btree ("key","at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "subs_app_started_idx" ON "subscriptions" USING btree ("app_id","started_at");--> statement-breakpoint
CREATE INDEX "subs_app_ended_idx" ON "subscriptions" USING btree ("app_id","ended_at");--> statement-breakpoint
CREATE INDEX "subs_app_shop_idx" ON "subscriptions" USING btree ("app_id","shop");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "trials_app_started_idx" ON "trials" USING btree ("app_id","started_at");