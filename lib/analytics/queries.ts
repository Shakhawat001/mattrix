import { and, asc, desc, eq, gte, ilike, inArray, lt, sql, type SQL } from "drizzle-orm"
import type { Db, Queryable } from "@/lib/db/client"
import { apps, connections, dailyMetrics, events, installs, settings, syncRuns } from "@/lib/db/schema"
import { parseTimestamp, parseTimestampOrNull } from "@/lib/db/timestamps"
import { DEFAULT_TIME_ZONE, endOfDay, normalizeTimeZone, startOfDay } from "@/lib/time-zone"
import { noRetention, type DayRow, type Retention } from "./aggregate"
import { addDays, type Range } from "./range"

// The reads behind every page. Each takes the apps to include, so one function serves
// "everything" and "this app". Dates are days in the dashboard's time zone, and a read that
// turns a day into instants takes that zone; a range includes both of its ends.

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
function inList(ids: string[]): SQL {
  return ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
}

/** The first instant of a day in the zone. */
const startOf = (date: string, timeZone: string) => startOfDay(date, timeZone)
/** The first instant after a day, so "on or before" a day is "before" this. */
const endOf = (date: string, timeZone: string) => endOfDay(date, timeZone)
/** A timestamp for a raw query: text with a cast, because the driver cannot encode a Date it has no column for. */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

// ---------------------------------------------------------------------------
// Apps and rollups
// ---------------------------------------------------------------------------

export type AppInfo = {
  id: string
  connectionId: string
  connectionLabel: string
  isDemo: boolean
  gid: string
  /** What the dashboard calls it: your own name if you set one, otherwise Shopify's. */
  label: string
  shopifyName: string
  displayName: string | null
  color: string | null
  hidden: boolean
  /** When the app first appeared here. Colors are handed out in this order, so an app keeps its color. */
  createdAt: Date
  firstEventAt: Date | null
  lastEventAt: Date | null
  derivedAt: Date | null
  /** The zone the app's numbers were last built in. Another one in Settings means a rebuild is pending. */
  derivedTimeZone: string | null
}

/**
 * Whether any of these apps has numbers built in another time zone than `timeZone`: the zone was
 * changed and the worker has not rebuilt them yet, so their daily rows still count the old days.
 * An app never built has nothing to mix up.
 */
export const awaitingRebuild = (list: Pick<AppInfo, "derivedAt" | "derivedTimeZone">[], timeZone: string): boolean =>
  list.some((a) => a.derivedAt !== null && a.derivedTimeZone !== timeZone)

export async function listApps(db: Queryable): Promise<AppInfo[]> {
  const rows = await db
    .select({
      id: apps.id,
      connectionId: apps.connectionId,
      connectionLabel: connections.label,
      isDemo: connections.isDemo,
      gid: apps.gid,
      name: apps.name,
      displayName: apps.displayName,
      color: apps.color,
      hidden: apps.hidden,
      createdAt: apps.createdAt,
      firstEventAt: apps.firstEventAt,
      lastEventAt: apps.lastEventAt,
      derivedAt: apps.derivedAt,
      derivedTimeZone: apps.derivedTimeZone,
    })
    .from(apps)
    .innerJoin(connections, eq(apps.connectionId, connections.id))
    .orderBy(asc(apps.name), asc(apps.id))
  return rows.map(({ name, ...r }) => ({ ...r, shopifyName: name, label: r.displayName?.trim() || name }))
}

/**
 * The zone days are counted in, from Settings. UTC until one is saved, and UTC too if the saved
 * one is unknown to this runtime, so the web server, the worker and the MCP endpoint always agree.
 */
export async function readTimeZone(db: Queryable): Promise<string> {
  const [row] = await db.select({ timeZone: settings.timeZone }).from(settings).where(eq(settings.id, 1))
  return normalizeTimeZone(row?.timeZone) ?? DEFAULT_TIME_ZONE
}

export async function earliestDate(db: Queryable, appIds: string[]): Promise<string | null> {
  if (appIds.length === 0) return null
  const [row] = await db.select({ first: sql<string | null>`min(${dailyMetrics.date})` }).from(dailyMetrics).where(inArray(dailyMetrics.appId, appIds))
  return row?.first ?? null
}

/** Rollup rows for the range and the day before it, which is where a range's starting stocks live. */
export async function getDayRows(db: Queryable, appIds: string[], range: Range): Promise<DayRow[]> {
  if (appIds.length === 0) return []
  return db
    .select()
    .from(dailyMetrics)
    .where(and(inArray(dailyMetrics.appId, appIds), sql`${dailyMetrics.date} >= ${addDays(range.from, -1)}`, sql`${dailyMetrics.date} <= ${range.to}`)) as Promise<DayRow[]>
}

// ---------------------------------------------------------------------------
// Churn, retention, trials, plans
// ---------------------------------------------------------------------------

export async function getReasons(db: Queryable, appIds: string[], range: Range, timeZone: string): Promise<{ reason: string; count: number }[]> {
  if (appIds.length === 0) return []
  const rows = await db.execute<{ reason: string; n: number }>(sql`
    SELECT btrim(r) AS reason, count(*)::int AS n
    FROM installs i,
         LATERAL unnest(string_to_array(coalesce(nullif(i.reason, ''), 'No reason given'), ',')) AS r
    WHERE i.app_id IN ${inList(appIds)}
      AND i.uninstalled_at >= ${ts(startOf(range.from, timeZone))} AND i.uninstalled_at < ${ts(endOf(range.to, timeZone))}
    GROUP BY 1
    ORDER BY n DESC, 1
  `)
  return rows.map((r) => ({ reason: r.reason, count: r.n }))
}

export type Explanation = { appId: string; shop: string; at: Date; reason: string | null; text: string }

/** The merchants' own words on leaving, newest first. */
export async function getExplanations(db: Queryable, appIds: string[], range: Range, timeZone: string, limit = 20): Promise<Explanation[]> {
  if (appIds.length === 0) return []
  const rows = await db
    .select({ appId: installs.appId, shop: installs.shop, at: installs.uninstalledAt, reason: installs.reason, text: installs.reasonDescription })
    .from(installs)
    .where(and(inArray(installs.appId, appIds), sql`${installs.reasonDescription} IS NOT NULL`, gte(installs.uninstalledAt, startOf(range.from, timeZone)), lt(installs.uninstalledAt, endOf(range.to, timeZone))))
    .orderBy(desc(installs.uninstalledAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, at: r.at as Date, text: r.text as string }))
}

/** The installs made in a range, for cohort retention. */
export async function getStays(db: Queryable, appIds: string[], range: Range, timeZone: string): Promise<{ installedAt: Date; uninstalledAt: Date | null }[]> {
  if (appIds.length === 0) return []
  return db
    .select({ installedAt: installs.installedAt, uninstalledAt: installs.uninstalledAt })
    .from(installs)
    .where(and(inArray(installs.appId, appIds), gte(installs.installedAt, startOf(range.from, timeZone)), lt(installs.installedAt, endOf(range.to, timeZone))))
}

/**
 * What became of the shops that were there when the range began. The starting group is the
 * shops with the app installed, and the paying subscribers (a trial that has not converted is not
 * one), at the first instant of the first day; the end is the last instant of the last day. An app with nobody at the start has no entry.
 * A shop that left and came back inside the range counts as kept: it has the app at the end.
 */
export async function getRetention(db: Queryable, appIds: string[], range: Range, timeZone: string): Promise<Map<string, Retention>> {
  const out = new Map<string, Retention>()
  if (appIds.length === 0) return out
  const t0 = ts(startOf(range.from, timeZone))
  const t1 = ts(endOf(range.to, timeZone))

  const [installRows, subRows] = await Promise.all([
    db.execute<{ app_id: string; start_n: number; kept_n: number }>(sql`
      WITH start_shops AS (
        SELECT DISTINCT app_id, shop FROM installs
        WHERE app_id IN ${inList(appIds)} AND installed_at < ${t0} AND (uninstalled_at IS NULL OR uninstalled_at >= ${t0})
      ), end_shops AS (
        SELECT DISTINCT app_id, shop FROM installs
        WHERE app_id IN ${inList(appIds)} AND installed_at < ${t1} AND (uninstalled_at IS NULL OR uninstalled_at >= ${t1})
      )
      SELECT s.app_id, count(*)::int AS start_n, count(e.shop)::int AS kept_n
      FROM start_shops s LEFT JOIN end_shops e USING (app_id, shop)
      GROUP BY s.app_id
    `),
    db.execute<{ app_id: string; start_n: number; kept_n: number; start_mrr: string; end_mrr: string; kept_mrr: string }>(sql`
      WITH start_subs AS (
        SELECT DISTINCT ON (app_id, shop) app_id, shop, monthly_cents AS start_cents FROM subscriptions
        WHERE app_id IN ${inList(appIds)} AND monthly_cents > 0 AND started_at < ${t0} AND (ended_at IS NULL OR ended_at >= ${t0})
          AND (trial_ends_at IS NULL OR converted_at < ${t0})
        ORDER BY app_id, shop, started_at DESC
      ), end_subs AS (
        SELECT DISTINCT ON (app_id, shop) app_id, shop,
               CASE WHEN trial_ends_at IS NULL OR converted_at < ${t1} THEN monthly_cents ELSE 0 END AS end_cents
        FROM subscriptions
        WHERE app_id IN ${inList(appIds)} AND started_at < ${t1} AND (ended_at IS NULL OR ended_at >= ${t1})
        ORDER BY app_id, shop, started_at DESC
      )
      SELECT s.app_id,
             count(*)::int AS start_n,
             (count(*) FILTER (WHERE coalesce(e.end_cents, 0) > 0))::int AS kept_n,
             sum(s.start_cents)::bigint AS start_mrr,
             sum(coalesce(e.end_cents, 0))::bigint AS end_mrr,
             sum(least(coalesce(e.end_cents, 0), s.start_cents))::bigint AS kept_mrr
      FROM start_subs s LEFT JOIN end_subs e USING (app_id, shop)
      GROUP BY s.app_id
    `),
  ])

  for (const r of installRows) out.set(r.app_id, { ...noRetention(), startInstalls: r.start_n, keptInstalls: r.kept_n })
  for (const r of subRows) {
    out.set(r.app_id, {
      ...(out.get(r.app_id) ?? noRetention()),
      startSubs: r.start_n,
      keptSubs: r.kept_n,
      startMrr: Number(r.start_mrr),
      endMrr: Number(r.end_mrr),
      keptMrr: Number(r.kept_mrr),
    })
  }
  return out
}

export type LifetimeStats = { ended: number; open: number; medianDays: number | null; meanDays: number | null; within1Day: number; within7Days: number; within30Days: number }

/** How long installs lasted, among those that ended in the range. */
export async function getLifetimeStats(db: Queryable, appIds: string[], range: Range, timeZone: string): Promise<LifetimeStats> {
  if (appIds.length === 0) return { ended: 0, open: 0, medianDays: null, meanDays: null, within1Day: 0, within7Days: 0, within30Days: 0 }
  const [row] = await db.execute<{ ended: number; open: number; median: number | null; mean: number | null; d1: number; d7: number; d30: number }>(sql`
    SELECT
      count(*) FILTER (WHERE uninstalled_at IS NOT NULL)::int AS ended,
      count(*) FILTER (WHERE uninstalled_at IS NULL)::int AS open,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (uninstalled_at - installed_at)) / 86400) FILTER (WHERE uninstalled_at IS NOT NULL) AS median,
      avg(extract(epoch FROM (uninstalled_at - installed_at)) / 86400) FILTER (WHERE uninstalled_at IS NOT NULL) AS mean,
      count(*) FILTER (WHERE uninstalled_at - installed_at < interval '1 day')::int AS d1,
      count(*) FILTER (WHERE uninstalled_at - installed_at < interval '7 days')::int AS d7,
      count(*) FILTER (WHERE uninstalled_at - installed_at < interval '30 days')::int AS d30
    FROM installs
    WHERE app_id IN ${inList(appIds)}
      AND (
        (uninstalled_at >= ${ts(startOf(range.from, timeZone))} AND uninstalled_at < ${ts(endOf(range.to, timeZone))})
        OR (uninstalled_at IS NULL AND installed_at < ${ts(endOf(range.to, timeZone))})
      )
  `)
  return {
    ended: row.ended,
    open: row.open,
    medianDays: row.median === null ? null : Number(row.median),
    meanDays: row.mean === null ? null : Number(row.mean),
    within1Day: row.d1,
    within7Days: row.d7,
    within30Days: row.d30,
  }
}

export type PlanMixRow = { planHandle: string; billingPeriod: string; subscribers: number; mrrCents: number }

/** Who pays for which plan at the end of a day. Shops still in a trial are left out. */
export async function getPlanMix(db: Db, appIds: string[], date: string, timeZone: string): Promise<PlanMixRow[]> {
  if (appIds.length === 0) return []
  const end = ts(endOf(date, timeZone))
  const rows = await db.execute<{ plan: string | null; period: string | null; n: number; mrr: string }>(sql`
    SELECT plan_handle AS plan, billing_period AS period, count(*)::int AS n, sum(monthly_cents)::bigint AS mrr
    FROM subscriptions
    WHERE app_id IN ${inList(appIds)} AND monthly_cents > 0
      AND started_at < ${end} AND (ended_at IS NULL OR ended_at >= ${end})
      AND (trial_ends_at IS NULL OR converted_at < ${end})
    GROUP BY 1, 2
    ORDER BY mrr DESC, 1, 2
  `)
  return rows.map((r) => ({ planHandle: r.plan ?? "Unnamed plan", billingPeriod: r.period === "ANNUAL" ? "Yearly" : "Monthly", subscribers: r.n, mrrCents: Number(r.mrr) }))
}

export type TrialStats = { started: number; converted: number; canceled: number; open: number; medianDaysToConvert: number | null }

/** What became of the trials that started in a range. */
export async function getTrialStats(db: Queryable, appIds: string[], range: Range, timeZone: string): Promise<TrialStats> {
  if (appIds.length === 0) return { started: 0, converted: 0, canceled: 0, open: 0, medianDaysToConvert: null }
  const [row] = await db.execute<{ started: number; converted: number; canceled: number; open: number; median: number | null }>(sql`
    SELECT
      count(*)::int AS started,
      count(*) FILTER (WHERE outcome = 'converted')::int AS converted,
      count(*) FILTER (WHERE outcome = 'canceled')::int AS canceled,
      count(*) FILTER (WHERE outcome = 'open')::int AS open,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (resolved_at - started_at)) / 86400) FILTER (WHERE outcome = 'converted') AS median
    FROM trials
    WHERE app_id IN ${inList(appIds)} AND started_at >= ${ts(startOf(range.from, timeZone))} AND started_at < ${ts(endOf(range.to, timeZone))}
  `)
  return { started: row.started, converted: row.converted, canceled: row.canceled, open: row.open, medianDaysToConvert: row.median === null ? null : Number(row.median) }
}

// ---------------------------------------------------------------------------
// Shops and events
// ---------------------------------------------------------------------------

export type ShopRow = {
  appId: string
  shop: string
  installed: boolean
  installs: number
  firstInstalledAt: Date
  lastInstalledAt: Date
  uninstalledAt: Date | null
  reason: string | null
  planHandle: string | null
  billingPeriod: string | null
  monthlyCents: number
  /** Paying for a plan now. */
  subscribed: boolean
  /** On a free trial of a paid plan now. */
  inTrial: boolean
  charged: number
}

export type ShopFilters = {
  q?: string
  /** One shop, by its exact domain as events store it. */
  shop?: string
  status?: "installed" | "uninstalled"
  plan?: "paying" | "trial" | "free" | "churned"
  sort?: "recent" | "mrr" | "revenue" | "shop"
  page?: number
  pageSize?: number
}

const SHOP_SORTS: Record<NonNullable<ShopFilters["sort"]>, string> = {
  recent: "last_installed_at DESC, shop",
  mrr: "subscribed DESC, monthly_cents DESC, shop",
  revenue: "charged DESC, shop",
  shop: "shop ASC",
}

/** One row per shop per app: where it stands, what it pays, what it has paid in all. */
export async function listShops(db: Queryable, appIds: string[], filters: ShopFilters = {}): Promise<{ rows: ShopRow[]; total: number }> {
  if (appIds.length === 0) return { rows: [], total: 0 }
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50))
  const offset = (Math.max(1, filters.page ?? 1) - 1) * pageSize

  const where: SQL[] = []
  if (filters.q?.trim()) where.push(sql`shop ILIKE ${`%${escapeLike(filters.q.trim())}%`}`)
  if (filters.shop !== undefined) where.push(sql`shop = ${filters.shop}`)
  if (filters.status === "installed") where.push(sql`uninstalled_at IS NULL`)
  if (filters.status === "uninstalled") where.push(sql`uninstalled_at IS NOT NULL`)
  if (filters.plan === "paying") where.push(sql`subscribed`)
  if (filters.plan === "trial") where.push(sql`in_trial`)
  if (filters.plan === "free") where.push(sql`uninstalled_at IS NULL AND NOT subscribed AND NOT in_trial`)
  if (filters.plan === "churned") where.push(sql`had_paid AND NOT subscribed`)
  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``
  const orderSql = sql.raw(SHOP_SORTS[filters.sort ?? "recent"])

  const rows = await db.execute<{
    // Raw SQL hands timestamps back as text, so they are read into Dates below.
    app_id: string; shop: string; installs: number; first_installed_at: string | Date; last_installed_at: string | Date; uninstalled_at: string | Date | null; reason: string | null
    plan_handle: string | null; billing_period: string | null; monthly_cents: string; subscribed: boolean; in_trial: boolean; charged: string; total: number
  }>(sql`
    WITH last_install AS (
      SELECT DISTINCT ON (app_id, shop) app_id, shop, installed_at AS last_installed_at, uninstalled_at, reason
      FROM installs WHERE app_id IN ${inList(appIds)}
      ORDER BY app_id, shop, installed_at DESC
    ), counts AS (
      SELECT app_id, shop, count(*)::int AS installs, min(installed_at) AS first_installed_at
      FROM installs WHERE app_id IN ${inList(appIds)} GROUP BY app_id, shop
    ), current_sub AS (
      SELECT DISTINCT ON (app_id, shop) app_id, shop, monthly_cents, plan_handle, billing_period, ended_at, trial_ends_at, converted_at
      FROM subscriptions WHERE app_id IN ${inList(appIds)}
      ORDER BY app_id, shop, started_at DESC
    ), ever_paid AS (
      SELECT DISTINCT app_id, shop FROM subscriptions
      WHERE app_id IN ${inList(appIds)} AND monthly_cents > 0 AND (trial_ends_at IS NULL OR converted_at IS NOT NULL)
    ), revenue AS (
      SELECT app_id, shop, sum(amount_cents)::bigint AS charged
      FROM events
      WHERE app_id IN ${inList(appIds)} AND shop IS NOT NULL AND type IN ('CHARGE_RECURRING', 'CHARGE_ONE_TIME', 'CHARGE_USAGE')
      GROUP BY app_id, shop
    ), joined AS (
      SELECT li.app_id, li.shop, c.installs, c.first_installed_at, li.last_installed_at, li.uninstalled_at, li.reason,
             cs.plan_handle, cs.billing_period,
             coalesce(cs.monthly_cents, 0)::bigint AS monthly_cents,
             (cs.ended_at IS NULL AND coalesce(cs.monthly_cents, 0) > 0 AND (cs.trial_ends_at IS NULL OR cs.converted_at IS NOT NULL)) AS subscribed,
             (cs.ended_at IS NULL AND coalesce(cs.monthly_cents, 0) > 0 AND cs.trial_ends_at IS NOT NULL AND cs.converted_at IS NULL) AS in_trial,
             (ep.shop IS NOT NULL) AS had_paid,
             coalesce(r.charged, 0)::bigint AS charged
      FROM last_install li
      JOIN counts c USING (app_id, shop)
      LEFT JOIN current_sub cs USING (app_id, shop)
      LEFT JOIN ever_paid ep USING (app_id, shop)
      LEFT JOIN revenue r USING (app_id, shop)
    )
    SELECT *, count(*) OVER ()::int AS total FROM joined
    ${whereSql}
    ORDER BY ${orderSql}
    LIMIT ${pageSize} OFFSET ${offset}
  `)

  return {
    total: rows[0]?.total ?? 0,
    rows: rows.map((r) => ({
      appId: r.app_id,
      shop: r.shop,
      installed: r.uninstalled_at === null,
      installs: r.installs,
      firstInstalledAt: parseTimestamp(r.first_installed_at),
      lastInstalledAt: parseTimestamp(r.last_installed_at),
      uninstalledAt: parseTimestampOrNull(r.uninstalled_at),
      reason: r.reason,
      planHandle: r.plan_handle,
      billingPeriod: r.billing_period,
      monthlyCents: Number(r.monthly_cents),
      subscribed: r.subscribed,
      inTrial: r.in_trial,
      charged: Number(r.charged),
    })),
  }
}

export type EventRow = {
  id: string
  appId: string
  type: string
  occurredAt: Date
  shop: string | null
  state: string | null
  reason: string | null
  reasonDescription: string | null
  planHandle: string | null
  billingPeriod: string | null
  amountCents: number | null
  grossCents: number | null
  netCents: number | null
  feeCents: number | null
}

export type EventFilters = { type?: string; shop?: string; range?: Range; page?: number; pageSize?: number }

/** `timeZone` says where a range's days begin and end. */
export async function listEvents(db: Db, appIds: string[], timeZone: string, filters: EventFilters = {}): Promise<{ rows: EventRow[]; total: number }> {
  if (appIds.length === 0) return { rows: [], total: 0 }
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50))
  const offset = (Math.max(1, filters.page ?? 1) - 1) * pageSize

  const conditions: (SQL | undefined)[] = [inArray(events.appId, appIds)]
  if (filters.type) conditions.push(eq(events.type, filters.type))
  if (filters.shop?.trim()) conditions.push(ilike(events.shop, `%${escapeLike(filters.shop.trim())}%`))
  if (filters.range) conditions.push(gte(events.occurredAt, startOf(filters.range.from, timeZone)), lt(events.occurredAt, endOf(filters.range.to, timeZone)))
  const where = and(...conditions)

  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: events.id, appId: events.appId, type: events.type, occurredAt: events.occurredAt, shop: events.shop, state: events.state,
        reason: events.reason, reasonDescription: events.reasonDescription, planHandle: events.planHandle, billingPeriod: events.billingPeriod,
        amountCents: events.amountCents, grossCents: events.grossCents, netCents: events.netCents, feeCents: events.feeCents,
      })
      .from(events)
      .where(where)
      .orderBy(desc(events.occurredAt), desc(events.id))
      .limit(pageSize)
      .offset(offset),
    db.select({ n: sql<number>`count(*)::int` }).from(events).where(where),
  ])
  return { rows, total: count?.n ?? 0 }
}

export async function listEventTypes(db: Db, appIds: string[]): Promise<string[]> {
  if (appIds.length === 0) return []
  const rows = await db.selectDistinct({ type: events.type }).from(events).where(inArray(events.appId, appIds)).orderBy(asc(events.type))
  return rows.map((r) => r.type)
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export type ConnectionOverview = {
  id: string
  label: string
  partnerId: string
  tokenHint: string
  apiVersion: string
  appGids: string[]
  backfillFrom: Date
  paused: boolean
  isDemo: boolean
  syncRequestedAt: Date | null
  lastRunAt: Date | null
  lastOkAt: Date | null
  lastError: string | null
  earningsError: string | null
  /** Why Shopify's payout ledger could not be read on the last sync. Net earnings then leave out the processing fee. */
  transactionsError: string | null
  legacyError: string | null
  createdAt: Date
  apps: number
  events: number
  runs: { id: string; trigger: string; startedAt: Date; ok: boolean | null; eventsInserted: number; error: string | null; durationMs: number | null }[]
}

export async function getConnections(db: Queryable): Promise<ConnectionOverview[]> {
  const rows = await db.select().from(connections).orderBy(asc(connections.createdAt))
  const counts = await db.execute<{ connection_id: string; apps: number; events: number }>(sql`
    SELECT a.connection_id, count(DISTINCT a.id)::int AS apps, count(e.id)::int AS events
    FROM apps a LEFT JOIN events e ON e.app_id = a.id
    GROUP BY a.connection_id
  `)
  const runs = await db
    .select({ id: syncRuns.id, connectionId: syncRuns.connectionId, trigger: syncRuns.trigger, startedAt: syncRuns.startedAt, ok: syncRuns.ok, eventsInserted: syncRuns.eventsInserted, error: syncRuns.error, durationMs: syncRuns.durationMs })
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(60)
  const countFor = new Map(counts.map((c) => [c.connection_id, c]))

  return rows.map((c) => ({
    id: c.id, label: c.label, partnerId: c.partnerId, tokenHint: c.tokenHint, apiVersion: c.apiVersion, appGids: c.appGids, backfillFrom: c.backfillFrom,
    paused: c.paused, isDemo: c.isDemo, syncRequestedAt: c.syncRequestedAt, lastRunAt: c.lastRunAt, lastOkAt: c.lastOkAt, lastError: c.lastError,
    earningsError: c.earningsError, transactionsError: c.transactionsError, legacyError: c.legacyError, createdAt: c.createdAt,
    apps: countFor.get(c.id)?.apps ?? 0,
    events: countFor.get(c.id)?.events ?? 0,
    runs: runs.filter((r) => r.connectionId === c.id).slice(0, 5).map((r) => ({ id: r.id, trigger: r.trigger, startedAt: r.startedAt, ok: r.ok, eventsInserted: r.eventsInserted, error: r.error, durationMs: r.durationMs })),
  }))
}
