import "server-only"
import { notFound } from "next/navigation"
import { cache } from "react"
import { requireSession } from "@/lib/auth/dal"
import { getDb } from "@/lib/db/client"
import { addRetention, bucketSeries, kpisFor, type DayRow, type Kpis, type Retention, type SeriesPoint } from "./aggregate"
import { loadPageParams, type PageParams, type SearchParams } from "./page-params"
import { getDayRows, getRetention, listApps, readTimeZone, type AppInfo } from "./queries"
import type { Range } from "./range"
import { appColors, appSeries, type AppSeries } from "./series"
import { COMPARE_OPTIONS, compareLabel } from "./url"

// What almost every page starts with: the apps it may show, the range and comparison from
// the URL, the rollup rows for them, and the headline numbers for the range and for the
// range it is compared with.

/**
 * Every app, hidden ones included. Read once per request, however many components ask.
 *
 * The session is checked here, in the data layer, and not only in the layout: Next.js can render
 * a page without running the layouts above it (a client-side navigation asks only for the
 * segments that changed), so a layout is not a gate. Every page reads its apps through this.
 */
export const getApps = cache(async () => {
  await requireSession()
  return listApps(getDb())
})

/**
 * The dashboard's time zone, from Settings: what every day is a day in and every time is
 * shown in. Read once per request, with the session checked like every other read.
 */
export const getTimeZone = cache(async () => {
  await requireSession()
  return readTimeZone(getDb())
})

/** One app that is not hidden, by an id from the URL, or a 404. Nothing else may be read by id. */
export async function requireVisibleApp(appId: string): Promise<AppInfo> {
  const app = (await getApps()).find((a) => a.id === appId && !a.hidden)
  if (!app) notFound()
  return app
}

export type Dashboard = {
  /** Every app, hidden ones included (Settings needs them, and colors are handed out across all of them). */
  all: AppInfo[]
  /** The apps that are not hidden. */
  visible: AppInfo[]
  /** The apps this page is about: one, or all visible. */
  scope: AppInfo[]
  /** The apps drawn: the page's scope narrowed by the apps filter. */
  shown: AppInfo[]
  /** Each app's own color, or null when it folds into "Other". */
  colors: Map<string, string | null>
  /** The shown apps as chart series. */
  series: AppSeries
  params: PageParams
  rows: DayRow[]
  /** All shown apps together, one point per bucket. Sparklines read from this. */
  points: SeriesPoint[]
  /** What became of the starting shops, per app, for the range and for the comparison range. */
  retention: Map<string, Retention>
  comparedRetention: Map<string, Retention> | null
  kpis: Kpis
  comparedKpis: Kpis | null
  /** "vs previous period", or "" when nothing is compared. */
  caption: string
  /** The comparison range and what to call it on a chart, or null. */
  comparison: { range: Range; label: string } | null
  now: Date
}

export async function loadDashboard(searchParams: SearchParams, appId?: string): Promise<Dashboard> {
  const db = getDb()
  const now = new Date()
  const [all, timeZone] = await Promise.all([getApps(), getTimeZone()])
  const visible = all.filter((a) => !a.hidden)
  const scope = appId ? visible.filter((a) => a.id === appId) : visible
  // An id that is not a visible app reads nothing.
  if (appId && scope.length === 0) notFound()
  const params = await loadPageParams(db, searchParams, scope, timeZone, now)
  const shown = scope.filter((a) => params.appIds.includes(a.id))

  // One read covers the range and the comparison range, and the day before each.
  const from = params.compared && params.compared.from < params.range.from ? params.compared.from : params.range.from
  const [rows, retention, comparedRetention] = await Promise.all([
    getDayRows(db, params.appIds, { from, to: params.range.to }),
    getRetention(db, params.appIds, params.range, timeZone),
    params.compared ? getRetention(db, params.appIds, params.compared, timeZone) : null,
  ])
  const colors = appColors(all)
  const together = (by: Map<string, Retention> | null) => (by ? addRetention([...by.values()]) : null)

  return {
    all,
    visible,
    scope,
    shown,
    colors,
    series: appSeries(shown, colors),
    params,
    rows,
    points: bucketSeries(rows, params.range, params.granularity),
    retention,
    comparedRetention,
    kpis: kpisFor(rows, params.range, together(retention)),
    comparedKpis: params.compared ? kpisFor(rows, params.compared, together(comparedRetention)) : null,
    caption: compareLabel(params.compare),
    comparison: params.compared ? { range: params.compared, label: COMPARE_OPTIONS.find((o) => o.value === params.compare)?.label ?? "Before" } : null,
    now,
  }
}
