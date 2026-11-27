import type { NextRequest } from "next/server"
import { dailyRows, eventRows, shopRows } from "@/lib/analytics/export"
import { awaitingRebuild, getDayRows, listEvents, listEventTypes, listShops, type EventFilters, type ShopFilters } from "@/lib/analytics/queries"
import { addDays, dayCount, isDate, type Range } from "@/lib/analytics/range"
import { getApps, getTimeZone } from "@/lib/analytics/scope"
import { oneOf } from "@/lib/analytics/url"
import { hasSession } from "@/lib/auth/dal"
import { toCsv } from "@/lib/csv"
import { getDb } from "@/lib/db/client"
import { todayIn } from "@/lib/time-zone"

// CSV downloads. The session is checked here, in the handler: the proxy is not a gate. Only
// apps that are not hidden can be exported, and every filter is validated before it is used.
// Dates are days in the dashboard's time zone, like on screen. Moments are written in UTC
// (ISO 8601 with a Z), which every spreadsheet and script reads the same way.

const MAX_ROWS = 100_000
const PAGE = 200
const MAX_SPAN_DAYS = 1830

const csv = (name: string, rows: unknown[][], truncated: boolean) =>
  new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(truncated ? { "X-Export-Truncated": `first ${MAX_ROWS} rows` } : {}),
    },
  })

const bad = (message: string) => Response.json({ error: message }, { status: 400 })

export async function GET(request: NextRequest) {
  if (!(await hasSession())) return Response.json({ error: "Not signed in." }, { status: 401 })

  const query = request.nextUrl.searchParams
  const kind = oneOf(query.get("kind") ?? undefined, ["daily", "shops", "events"] as const)
  if (!kind) return bad("Unknown export.")

  const [all, timeZone] = await Promise.all([getApps(), getTimeZone()])
  const apps = all.filter((a) => !a.hidden)
  const labels = new Map(apps.map((a) => [a.id, a.label]))
  const labelOf = (id: string) => labels.get(id) ?? "Unknown app"
  const db = getDb()

  // The range, when the export has one.
  const today = todayIn(timeZone)
  const from = query.get("from") ?? undefined
  const to = query.get("to") ?? undefined
  const range: Range | null = isDate(from) && isDate(to) && from <= to ? { from, to: to > today ? today : to } : null
  if (range && dayCount(range) > MAX_SPAN_DAYS) range.from = addDays(range.to, -(MAX_SPAN_DAYS - 1))
  const stamp = range ? `${range.from}-to-${range.to}` : today

  if (kind === "daily") {
    if (!range) return bad("A date range is needed.")
    const asked = (query.get("apps") ?? "").split(",").filter((id) => labels.has(id))
    const ids = asked.length > 0 ? asked : apps.map((a) => a.id)
    // Right after the time zone changed, the daily rows still count the old days. A file is kept
    // and passed on, so it waits until they are rebuilt rather than carry the wrong days unmarked.
    if (awaitingRebuild(apps.filter((a) => ids.includes(a.id)), timeZone)) {
      return Response.json({ error: `The daily numbers are being rebuilt with days in ${timeZone}. Try again once that is done; it usually takes under a minute.` }, { status: 503, headers: { "Retry-After": "30" } })
    }
    const rows = await getDayRows(db, ids, range)
    return csv(`appmetrics-daily-${stamp}.csv`, dailyRows(rows, labelOf, range), false)
  }

  const appId = query.get("app") ?? ""
  if (!labels.has(appId)) return bad("Unknown app.")

  if (kind === "shops") {
    const filters: ShopFilters = {
      q: (query.get("q") ?? "").slice(0, 100),
      status: oneOf(query.get("status") ?? undefined, ["installed", "uninstalled"] as const),
      plan: oneOf(query.get("plan") ?? undefined, ["paying", "trial", "free", "churned"] as const),
      sort: oneOf(query.get("sort") ?? undefined, ["recent", "mrr", "revenue", "shop"] as const) ?? "recent",
    }
    const rows = []
    let total = 0
    for (let page = 1; rows.length < MAX_ROWS; page++) {
      const batch = await listShops(db, [appId], { ...filters, page, pageSize: PAGE })
      total = batch.total
      rows.push(...batch.rows)
      if (batch.rows.length === 0 || rows.length >= total) break
    }
    return csv(`appmetrics-shops-${stamp}.csv`, shopRows(rows, labelOf), total > rows.length)
  }

  const types = await listEventTypes(db, [appId])
  const filters: EventFilters = {
    type: oneOf(query.get("type") ?? undefined, types),
    shop: (query.get("shop") ?? "").slice(0, 100),
    range: range ?? undefined,
  }
  const rows = []
  let total = 0
  for (let page = 1; rows.length < MAX_ROWS; page++) {
    const batch = await listEvents(db, [appId], timeZone, { ...filters, page, pageSize: PAGE })
    total = batch.total
    rows.push(...batch.rows)
    if (batch.rows.length === 0 || rows.length >= total) break
  }
  return csv(`appmetrics-events-${stamp}.csv`, eventRows(rows, labelOf), total > rows.length)
}
