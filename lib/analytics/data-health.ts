import { asc, inArray, sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { apps, connections } from "@/lib/db/schema"
import { parseTimestamp, parseTimestampOrNull } from "@/lib/db/timestamps"
import { DERIVE_VERSION } from "./derive"
import { fromMs } from "./range"

// How complete the stored data is. Per app: what arrived and when, and the signs of gaps: a
// history that starts after the shops did (uninstalls and shops with no install, subscriptions
// first seen in an update, paying shops with no subscription) and prices Shopify did not send.
// Per connection: how far the syncs have read and how they went.

const MONTHS = 12
const RUNS = 5

export type EventTypeHealth = {
  /** RELATIONSHIP_INSTALLED, SUBSCRIPTION_CREATED, CHARGE_RECURRING, EARNING_REFUND, ... */
  type: string
  count: number
  /** Events of this type with no shop. Expected for some earnings adjustments, a gap anywhere else. */
  withoutShop: number
  firstAt: Date
  lastAt: Date
  /** Events per month, in the order of `DataHealth.months`. */
  perMonth: number[]
}

export type AppHealth = {
  appId: string
  connectionId: string
  /** The first and last event stored, of any type. Null when there is none. */
  firstEventAt: Date | null
  lastEventAt: Date | null
  eventCount: number
  /** Every event type the app has, by name. */
  eventTypes: EventTypeHealth[]
  /** Uninstalls of a shop with no install event at or before them, or with no shop: the install came before the history starts, or Shopify did not send it. */
  uninstallsWithNoInstall: number
  /** Shops with events but no install event at all. The ones still installed are missing from active installs. */
  shopsWithNoInstall: number
  /** Subscriptions first seen in an update: they began before the history starts (or Shopify did not send the creation), so they count as new on the update's date. */
  subscriptionsWithNoCreation: number
  /** Shops charged for a recurring plan that have no subscription in the data: it began before the history and never changed since, so MRR leaves them out. */
  chargedShopsWithNoSubscription: number
  /** Subscriptions counted at $0 because Shopify sent no flat price: a usage-only plan, or a price missing from the data. */
  subscriptionsWithNoPrice: number
  /** The same by plan, most first. A usage-only plan of your own is expected here. */
  noPricePlans: { planHandle: string | null; count: number }[]
  /** When the derived tables and daily numbers were last built. */
  derivedAt: Date | null
  /** New events are waiting for the next rebuild. */
  dirty: boolean
  /** Built with an older version of the rules (DERIVE_VERSION in derive.ts): the worker rebuilds it on its next run. */
  rulesOutdated: boolean
}

export type SyncRunHealth = {
  /** startup, schedule or manual. */
  trigger: string
  startedAt: Date
  finishedAt: Date | null
  /** Null while the run is going, or when the worker stopped in the middle of it. */
  ok: boolean | null
  eventsInserted: number
  appsFound: number
  /** Cleaned of the token before it was stored. */
  error: string | null
  durationMs: number | null
}

export type ConnectionHealth = {
  connectionId: string
  label: string
  isDemo: boolean
  paused: boolean
  apiVersion: string
  /** How far back the history was asked for. Nothing before it is read. */
  backfillFrom: Date
  /** How far each pass has read: the core events (installs, subscriptions, charges), and earnings. */
  coreWatermark: Date | null
  earningsWatermark: Date | null
  /** A sync asked for in Settings that has not started yet. */
  syncRequestedAt: Date | null
  lastRunAt: Date | null
  lastOkAt: Date | null
  /** The last run's error, cleaned of the token. */
  lastError: string | null
  /** Why the earnings pass failed, usually a token that cannot read earnings. The other events still sync. */
  earningsError: string | null
  /** The latest sync runs, newest first. */
  runs: SyncRunHealth[]
}

export type DataHealth = {
  /** The months `perMonth` counts: the current UTC month and the eleven before it, oldest first, each as its first day (YYYY-MM-01). */
  months: string[]
  /** The apps asked for that exist, in the order asked. */
  apps: AppHealth[]
  /** The connections those apps belong to, oldest first. */
  connections: ConnectionHealth[]
}

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
function inList(ids: string[]): SQL {
  return ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
}

/** A timestamp for a raw query: text with a cast, because the driver cannot encode a Date it has no column for. */
const ts = (ms: number): SQL => sql`${new Date(ms).toISOString()}::timestamptz`

type Stamp = string | Date

/** How complete the data of these apps is, and how their connections' syncs went. */
export async function getDataHealth(db: Queryable, appIds: string[], now: Date = new Date()): Promise<DataHealth> {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  const months = Array.from({ length: MONTHS }, (_, i) => fromMs(Date.UTC(year, month - MONTHS + 1 + i, 1)))
  if (appIds.length === 0) return { months, apps: [], connections: [] }
  const ids = inList(appIds)

  const [appRows, typeRows, monthRows, uninstallRows, shopRows, noCreationRows, chargedRows, noPriceRows, connectionRows, runRows] = await Promise.all([
    db
      .select({ id: apps.id, connectionId: apps.connectionId, derivedAt: apps.derivedAt, dirty: apps.dirty, deriveVersion: apps.deriveVersion })
      .from(apps)
      .where(inArray(apps.id, appIds)),
    db.execute<{ app_id: string; type: string; n: number; no_shop: number; first_at: Stamp; last_at: Stamp }>(sql`
      SELECT app_id, type, count(*)::int AS n, (count(*) FILTER (WHERE shop IS NULL))::int AS no_shop,
             min(occurred_at) AS first_at, max(occurred_at) AS last_at
      FROM events WHERE app_id IN ${ids}
      GROUP BY app_id, type
    `),
    db.execute<{ app_id: string; type: string; month: string; n: number }>(sql`
      SELECT app_id, type, to_char(date_trunc('month', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS month, count(*)::int AS n
      FROM events
      WHERE app_id IN ${ids} AND occurred_at >= ${ts(Date.UTC(year, month - MONTHS + 1, 1))} AND occurred_at < ${ts(Date.UTC(year, month + 1, 1))}
      GROUP BY 1, 2, 3
    `),
    // On the same instant an install comes before an uninstall, as derive() reads them.
    db.execute<{ app_id: string; n: number }>(sql`
      WITH relationship AS (
        SELECT app_id, shop, type,
               count(*) FILTER (WHERE type = 'RELATIONSHIP_INSTALLED')
                 OVER (PARTITION BY app_id, shop ORDER BY occurred_at, type = 'RELATIONSHIP_UNINSTALLED') AS installs_so_far
        FROM events
        WHERE app_id IN ${ids} AND type IN ('RELATIONSHIP_INSTALLED', 'RELATIONSHIP_UNINSTALLED')
      )
      SELECT app_id, count(*)::int AS n FROM relationship
      WHERE type = 'RELATIONSHIP_UNINSTALLED' AND (shop IS NULL OR installs_so_far = 0)
      GROUP BY app_id
    `),
    db.execute<{ app_id: string; n: number }>(sql`
      SELECT app_id, count(*)::int AS n FROM (
        SELECT app_id, shop FROM events
        WHERE app_id IN ${ids} AND shop IS NOT NULL
        GROUP BY app_id, shop
        HAVING bool_and(type <> 'RELATIONSHIP_INSTALLED')
      ) never_installed
      GROUP BY app_id
    `),
    // A period derive() began from an update: no creation event opened it.
    db.execute<{ app_id: string; n: number }>(sql`
      SELECT s.app_id, count(*)::int AS n FROM subscriptions s
      WHERE s.app_id IN ${ids} AND s.kind = 'new'
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.app_id = s.app_id AND e.shop = s.shop AND e.occurred_at = s.started_at AND e.type = 'SUBSCRIPTION_CREATED'
        )
      GROUP BY s.app_id
    `),
    db.execute<{ app_id: string; n: number }>(sql`
      SELECT e.app_id, count(DISTINCT e.shop)::int AS n FROM events e
      WHERE e.app_id IN ${ids} AND e.type = 'CHARGE_RECURRING' AND e.amount_cents > 0 AND e.shop IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.app_id = e.app_id AND s.shop = e.shop)
      GROUP BY e.app_id
    `),
    // Only a new subscription can be priced at nothing: a plan change with no price keeps the one before.
    db.execute<{ app_id: string; plan_handle: string | null; n: number }>(sql`
      SELECT s.app_id, s.plan_handle, count(*)::int AS n FROM subscriptions s
      WHERE s.app_id IN ${ids} AND s.kind = 'new' AND s.monthly_cents = 0
        AND NOT EXISTS (
          SELECT 1 FROM events e
          WHERE e.app_id = s.app_id AND e.shop = s.shop AND e.occurred_at = s.started_at
            AND e.type IN ('SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED') AND e.amount_cents IS NOT NULL
        )
      GROUP BY s.app_id, s.plan_handle
      ORDER BY n DESC, s.plan_handle NULLS LAST
    `),
    db
      .select({
        id: connections.id,
        label: connections.label,
        isDemo: connections.isDemo,
        paused: connections.paused,
        apiVersion: connections.apiVersion,
        backfillFrom: connections.backfillFrom,
        coreWatermark: connections.coreWatermark,
        earningsWatermark: connections.earningsWatermark,
        syncRequestedAt: connections.syncRequestedAt,
        lastRunAt: connections.lastRunAt,
        lastOkAt: connections.lastOkAt,
        lastError: connections.lastError,
        earningsError: connections.earningsError,
      })
      .from(connections)
      .where(inArray(connections.id, db.select({ id: apps.connectionId }).from(apps).where(inArray(apps.id, appIds))))
      .orderBy(asc(connections.createdAt), asc(connections.id)),
    db.execute<{
      connection_id: string; trigger: string; started_at: Stamp; finished_at: Stamp | null; ok: boolean | null
      events_inserted: number; apps_found: number; error: string | null; duration_ms: number | null
    }>(sql`
      SELECT connection_id, trigger, started_at, finished_at, ok, events_inserted, apps_found, error, duration_ms
      FROM (
        SELECT r.*, row_number() OVER (PARTITION BY r.connection_id ORDER BY r.started_at DESC, r.id DESC) AS n
        FROM sync_runs r
        WHERE r.connection_id IN (SELECT connection_id FROM apps WHERE id IN ${ids})
      ) latest
      WHERE n <= ${RUNS}
      ORDER BY started_at DESC, n
    `),
  ])

  const monthIndex = new Map(months.map((m, i) => [m, i]))
  const perMonth = new Map<string, number[]>()
  for (const r of monthRows) {
    const i = monthIndex.get(r.month)
    if (i === undefined) continue
    const key = `${r.app_id} ${r.type}`
    let counts = perMonth.get(key)
    if (!counts) perMonth.set(key, (counts = new Array<number>(MONTHS).fill(0)))
    counts[i] += r.n
  }
  const countBy = (rows: { app_id: string; n: number }[]) => new Map(rows.map((r) => [r.app_id, r.n]))
  const uninstalls = countBy(uninstallRows)
  const neverInstalled = countBy(shopRows)
  const noCreation = countBy(noCreationRows)
  const charged = countBy(chargedRows)

  const byId = new Map(appRows.map((a) => [a.id, a]))
  const appHealth = appIds.flatMap((appId): AppHealth[] => {
    const app = byId.get(appId)
    if (!app) return []
    const eventTypes: EventTypeHealth[] = typeRows
      .filter((r) => r.app_id === appId)
      .map((r) => ({
        type: r.type,
        count: r.n,
        withoutShop: r.no_shop,
        firstAt: parseTimestamp(r.first_at),
        lastAt: parseTimestamp(r.last_at),
        perMonth: perMonth.get(`${appId} ${r.type}`) ?? new Array<number>(MONTHS).fill(0),
      }))
      .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0))
    const noPricePlans = noPriceRows.filter((r) => r.app_id === appId).map((r) => ({ planHandle: r.plan_handle, count: r.n }))
    const first = eventTypes.reduce<Date | null>((min, t) => (min === null || t.firstAt < min ? t.firstAt : min), null)
    const last = eventTypes.reduce<Date | null>((max, t) => (max === null || t.lastAt > max ? t.lastAt : max), null)
    return [
      {
        appId,
        connectionId: app.connectionId,
        firstEventAt: first,
        lastEventAt: last,
        eventCount: eventTypes.reduce((sum, t) => sum + t.count, 0),
        eventTypes,
        uninstallsWithNoInstall: uninstalls.get(appId) ?? 0,
        shopsWithNoInstall: neverInstalled.get(appId) ?? 0,
        subscriptionsWithNoCreation: noCreation.get(appId) ?? 0,
        chargedShopsWithNoSubscription: charged.get(appId) ?? 0,
        subscriptionsWithNoPrice: noPricePlans.reduce((sum, p) => sum + p.count, 0),
        noPricePlans,
        derivedAt: app.derivedAt,
        dirty: app.dirty,
        rulesOutdated: app.deriveVersion < DERIVE_VERSION,
      },
    ]
  })

  return {
    months,
    apps: appHealth,
    connections: connectionRows.map(({ id, ...c }) => ({
      connectionId: id,
      ...c,
      runs: runRows
        .filter((r) => r.connection_id === id)
        .map((r) => ({
          trigger: r.trigger,
          startedAt: parseTimestamp(r.started_at),
          finishedAt: parseTimestampOrNull(r.finished_at),
          ok: r.ok,
          eventsInserted: r.events_inserted,
          appsFound: r.apps_found,
          error: r.error,
          durationMs: r.duration_ms,
        })),
    })),
  }
}
