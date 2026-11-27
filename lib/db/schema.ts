import { sql } from "drizzle-orm"
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"

// Three layers of data:
//
//   raw      events: what Shopify's Partner API sent, untouched
//   derived  installs, subscriptions, trials: rebuilt from the events after a sync
//   rollup   daily_metrics: one row per app per day, what the charts read
//
// Derived and rollup tables can be thrown away and rebuilt at any time from events.
// Money is stored in cents. Every timestamp is stored as an instant (timestamptz). A day in the
// rollup is a calendar day in the dashboard's time zone, which is picked in Settings.

const tz = (name: string) => timestamp(name, { withTimezone: true })
const cents = (name: string) => bigint(name, { mode: "number" })

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** A Partner organization and the API token that can read it. One token covers every app in the organization. */
export const connections = pgTable("connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  partnerId: text("partner_id").notNull(),
  /** AES-256-GCM, see lib/crypto.ts. Never sent to the browser. */
  tokenCiphertext: text("token_ciphertext").notNull(),
  /** The last four characters, so connections can be told apart. */
  tokenHint: text("token_hint").notNull(),
  apiVersion: text("api_version").notNull().default("2026-07"),
  /** Optional: read only these apps. Empty means every app in the organization. */
  appGids: text("app_gids").array().notNull().default(sql`ARRAY[]::text[]`),
  backfillFrom: tz("backfill_from").notNull(),
  paused: boolean("paused").notNull().default(false),
  /** Demo data from `cli seed-demo`. The worker never calls Shopify for these. */
  isDemo: boolean("is_demo").notNull().default(false),
  syncRequestedAt: tz("sync_requested_at"),
  coreWatermark: tz("core_watermark"),
  earningsWatermark: tz("earnings_watermark"),
  /** How far the billing screen events of the older App.events have been read. */
  legacyWatermark: tz("legacy_watermark"),
  lastRunAt: tz("last_run_at"),
  lastOkAt: tz("last_ok_at"),
  lastError: text("last_error"),
  earningsError: text("earnings_error"),
  /** Why the billing screen events could not be read. Everything else still syncs. */
  legacyError: text("legacy_error"),
  createdAt: tz("created_at").notNull().defaultNow(),
})

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    /** gid://shopify/App/123 */
    gid: text("gid").notNull(),
    apiKey: text("api_key"),
    /** The name Shopify reports. */
    name: text("name").notNull(),
    /** Your own name for it, if you set one. */
    displayName: text("display_name"),
    color: text("color"),
    hidden: boolean("hidden").notNull().default(false),
    firstEventAt: tz("first_event_at"),
    lastEventAt: tz("last_event_at"),
    /** New events arrived since the derived tables were last built. */
    dirty: boolean("dirty").notNull().default(true),
    derivedAt: tz("derived_at"),
    /** The DERIVE_VERSION (lib/analytics/derive.ts) the derived tables were built with. 0 is from before versions were kept. */
    deriveVersion: integer("derive_version").notNull().default(0),
    /** The time zone the derived tables were built in. When Settings names another, they are rebuilt. */
    derivedTimeZone: text("derived_time_zone"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("apps_connection_gid_uq").on(t.connectionId, t.gid)],
)

/**
 * Shops left out of every number of every app: your own development stores, test installs,
 * Shopify's review stores. Their events stay stored; the derived tables are built without them.
 */
export const excludedShops = pgTable("excluded_shops", {
  /** The myshopify.com domain in lower case, as events store it. */
  shop: text("shop").primaryKey(),
  note: text("note"),
  createdAt: tz("created_at").notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Raw events
// ---------------------------------------------------------------------------

export const events = pgTable(
  "events",
  {
    /** Shopify's own event id, so reading the same event twice stores it once. */
    id: text("id").primaryKey(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /** RELATIONSHIP_INSTALLED, SUBSCRIPTION_CREATED, CHARGE_RECURRING, EARNING_REFUND, ... */
    type: text("type").notNull(),
    occurredAt: tz("occurred_at").notNull(),
    shop: text("shop"),
    shopGid: text("shop_gid"),
    state: text("state"),
    reason: text("reason"),
    reasonDescription: text("reason_description"),
    planHandle: text("plan_handle"),
    billingPeriod: text("billing_period"),
    trialDays: integer("trial_days"),
    trialDaysRemaining: integer("trial_days_remaining"),
    /** When a canceled subscription actually ends, if Shopify gives a date. */
    cancelEffectiveOn: tz("cancel_effective_on"),
    amountCents: cents("amount_cents"),
    currency: text("currency"),
    grossCents: cents("gross_cents"),
    netCents: cents("net_cents"),
    feeCents: cents("fee_cents"),
    chargeId: text("charge_id"),
    /** The event as Shopify sent it, so a field added later can be used without a new sync. */
    payload: jsonb("payload").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("events_app_time_idx").on(t.appId, t.occurredAt),
    index("events_app_type_time_idx").on(t.appId, t.type, t.occurredAt),
    index("events_app_shop_time_idx").on(t.appId, t.shop, t.occurredAt),
  ],
)

// ---------------------------------------------------------------------------
// Derived, rebuilt from events (lib/analytics/derive.ts)
// ---------------------------------------------------------------------------

/** One stay of one shop: from an install to its uninstall, or still open. */
export const installs = pgTable(
  "installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    shop: text("shop").notNull(),
    /** 1 for the first install of this shop, 2 for the first reinstall, and so on. */
    seq: integer("seq").notNull(),
    installedAt: tz("installed_at").notNull(),
    uninstalledAt: tz("uninstalled_at"),
    reason: text("reason"),
    reasonDescription: text("reason_description"),
  },
  (t) => [
    index("installs_app_installed_idx").on(t.appId, t.installedAt),
    index("installs_app_uninstalled_idx").on(t.appId, t.uninstalledAt),
    index("installs_app_shop_idx").on(t.appId, t.shop),
  ],
)

/** One period of one shop on one plan at one price. A plan change closes a period and opens the next. */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    shop: text("shop").notNull(),
    startedAt: tz("started_at").notNull(),
    endedAt: tz("ended_at"),
    /** canceled, uninstalled, frozen or replaced (by a plan change). */
    endReason: text("end_reason"),
    /** new, change (a plan change) or resume (unfrozen). */
    kind: text("kind").notNull(),
    /** The price per month; a yearly price divided by twelve. Zero for a free plan. */
    monthlyCents: cents("monthly_cents").notNull(),
    previousMonthlyCents: cents("previous_monthly_cents"),
    planHandle: text("plan_handle"),
    billingPeriod: text("billing_period"),
    trialEndsAt: tz("trial_ends_at"),
    /** First recurring charge, which is when a trial turned into money. */
    convertedAt: tz("converted_at"),
    /** When Shopify first said this period is canceled from a later day (cancelEffectiveOn). */
    cancelScheduledAt: tz("cancel_scheduled_at"),
    /** The start of that UTC day. An open period with one is set to end then. */
    cancelEffectiveAt: tz("cancel_effective_at"),
  },
  (t) => [
    index("subs_app_started_idx").on(t.appId, t.startedAt),
    index("subs_app_ended_idx").on(t.appId, t.endedAt),
    index("subs_app_shop_idx").on(t.appId, t.shop),
  ],
)

export const trials = pgTable(
  "trials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    shop: text("shop").notNull(),
    startedAt: tz("started_at").notNull(),
    endsAt: tz("ends_at").notNull(),
    trialDays: integer("trial_days").notNull(),
    resolvedAt: tz("resolved_at"),
    /** converted, canceled, open (still running) or unclear (ended with neither). */
    outcome: text("outcome").notNull(),
  },
  (t) => [index("trials_app_started_idx").on(t.appId, t.startedAt)],
)

// ---------------------------------------------------------------------------
// Rollup: what the charts read
// ---------------------------------------------------------------------------

/** One row per app per day in the dashboard's time zone. Flows are what happened that day; stocks are the value at the end of it. */
export const dailyMetrics = pgTable(
  "daily_metrics",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    // flows
    installs: integer("installs").notNull().default(0),
    reinstalls: integer("reinstalls").notNull().default(0),
    uninstalls: integer("uninstalls").notNull().default(0),
    newSubs: integer("new_subs").notNull().default(0),
    canceledSubs: integer("canceled_subs").notNull().default(0),
    trialsStarted: integer("trials_started").notNull().default(0),
    trialsConverted: integer("trials_converted").notNull().default(0),
    trialsCanceled: integer("trials_canceled").notNull().default(0),
    newMrrCents: cents("new_mrr_cents").notNull().default(0),
    expansionMrrCents: cents("expansion_mrr_cents").notNull().default(0),
    contractionMrrCents: cents("contraction_mrr_cents").notNull().default(0),
    churnedMrrCents: cents("churned_mrr_cents").notNull().default(0),
    chargedCents: cents("charged_cents").notNull().default(0),
    grossEarnedCents: cents("gross_earned_cents").notNull().default(0),
    netEarnedCents: cents("net_earned_cents").notNull().default(0),
    feeCents: cents("fee_cents").notNull().default(0),
    refundedCents: cents("refunded_cents").notNull().default(0),
    creditCents: cents("credit_cents").notNull().default(0),
    /** Store billing accounts Shopify deactivated (closed, paused or unpaid) and reactivated. */
    deactivations: integer("deactivations").notNull().default(0),
    reactivations: integer("reactivations").notNull().default(0),
    /** The parts of uninstalls, canceled subscribers and churned MRR that were the store going inactive. */
    uninstallsStoreInactive: integer("uninstalls_store_inactive").notNull().default(0),
    canceledSubsStoreInactive: integer("canceled_subs_store_inactive").notNull().default(0),
    churnedMrrStoreInactiveCents: cents("churned_mrr_store_inactive_cents").notNull().default(0),
    // stocks
    activeInstalls: integer("active_installs").notNull().default(0),
    /** Paying subscribers. A free trial is not one until it converts. */
    activeSubs: integer("active_subs").notNull().default(0),
    /** Subscriptions still in their free trial. */
    trialSubs: integer("trial_subs").notNull().default(0),
    /** Paying MRR. */
    mrrCents: cents("mrr_cents").notNull().default(0),
    /** What the running trials would add to MRR if they all converted. */
    trialMrrCents: cents("trial_mrr_cents").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.appId, t.date] })],
)

// ---------------------------------------------------------------------------
// Annotations: your own notes, not rebuilt from events
// ---------------------------------------------------------------------------

/** A day marked with a short label: a price change, a release, an App Store feature, an ad campaign. */
export const annotations = pgTable(
  "annotations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The app it is about. Null means every app. */
    appId: uuid("app_id").references(() => apps.id, { onDelete: "cascade" }),
    /** A UTC day. */
    date: date("date", { mode: "string" }).notNull(),
    /** At most 60 characters, checked before saving. */
    label: text("label").notNull(),
    /** At most 500 characters, checked before saving. */
    note: text("note"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  // Serves "these apps in this range" (app_id IN (...) OR app_id IS NULL) and the cascade from apps.
  (t) => [index("annotations_app_date_idx").on(t.appId, t.date)],
)

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** What is changed from the Settings page. One row, written the first time something is saved; until then every default applies. */
export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    /** The IANA time zone that days are counted in and times are shown in. */
    timeZone: text("time_zone").notNull().default("UTC"),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [check("settings_one_row", sql`${t.id} = 1`)],
)

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull(),
    startedAt: tz("started_at").notNull().defaultNow(),
    finishedAt: tz("finished_at"),
    ok: boolean("ok"),
    eventsInserted: integer("events_inserted").notNull().default(0),
    appsFound: integer("apps_found").notNull().default(0),
    error: text("error"),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("sync_runs_connection_started_idx").on(t.connectionId, t.startedAt)],
)

/** Logged-in browsers. The cookie holds a random token; only its HMAC is stored here. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastSeenAt: tz("last_seen_at").notNull().defaultNow(),
    expiresAt: tz("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_expires_idx").on(t.expiresAt)],
)

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    key: text("key").notNull(),
    at: tz("at").notNull().defaultNow(),
    ok: boolean("ok").notNull(),
  },
  (t) => [index("login_attempts_key_at_idx").on(t.key, t.at)],
)

/** Read-only tokens for AI agents (the MCP endpoint). Like sessions, only an HMAC of the token is stored. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    /** The last four characters, so tokens can be told apart. */
    hint: text("hint").notNull(),
    /** Shop domains are replaced by stable aliases in everything this token reads. */
    hideShops: boolean("hide_shops").notNull().default(false),
    createdAt: tz("created_at").notNull().defaultNow(),
    lastUsedAt: tz("last_used_at"),
    expiresAt: tz("expires_at"),
    revokedAt: tz("revoked_at"),
  },
  (t) => [uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash)],
)

/** One row per tool call made with an API token. Kept for 30 days. */
export const apiCalls = pgTable(
  "api_calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    at: tz("at").notNull().defaultNow(),
    tool: text("tool").notNull(),
    ok: boolean("ok").notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [index("api_calls_token_at_idx").on(t.tokenId, t.at)],
)
