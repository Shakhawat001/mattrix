import { addRetention, kpisFor, noRetention, seriesByApp, type DayRow, type Kpis, type Retention } from "./aggregate"
import type { MetricId } from "./metrics-registry"
import { metricValue } from "./metrics-registry"
import type { Granularity, Range } from "./range"

// The numbers behind the app-by-metric table on the Overview page. Built here, not in the
// page, so it can be tested: each app's KPIs come from only that app's rows and only that
// app's starting shops.

export type MatrixInput = { id: string; label: string; color: string; href: string }

export type BuiltRow = {
  id: string
  label: string
  color: string
  href: string
  values: Partial<Record<MetricId, number | null>>
  before: Partial<Record<MetricId, number | null>> | null
  spark: number[]
}

type RetentionByApp = Map<string, Retention> | null

const pick = (kpis: Kpis, columns: MetricId[]) => Object.fromEntries(columns.map((id) => [id, metricValue(kpis, id)])) as Partial<Record<MetricId, number | null>>
const retentionOf = (by: RetentionByApp, id: string) => by?.get(id) ?? noRetention()

export function buildMatrix(
  apps: MatrixInput[],
  rows: DayRow[],
  range: Range,
  compared: Range | null,
  granularity: Granularity,
  columns: MetricId[],
  retention: RetentionByApp,
  comparedRetention: RetentionByApp,
): { rows: BuiltRow[]; total: BuiltRow } {
  const trend = seriesByApp(rows, range, granularity, "mrrCents")

  const built = apps.map((app) => {
    const own = rows.filter((r) => r.appId === app.id)
    return {
      ...app,
      values: pick(kpisFor(own, range, retentionOf(retention, app.id)), columns),
      before: compared ? pick(kpisFor(own, compared, retentionOf(comparedRetention, app.id)), columns) : null,
      spark: trend.map((p) => p.values[app.id] ?? 0),
    }
  })

  const chosen = new Set(apps.map((a) => a.id))
  const everything = rows.filter((r) => chosen.has(r.appId))
  const together = (by: RetentionByApp) => addRetention(apps.map((a) => retentionOf(by, a.id)))
  const total: BuiltRow = {
    id: "total",
    label: "All apps",
    color: "var(--series-other)",
    href: "",
    values: pick(kpisFor(everything, range, together(retention)), columns),
    before: compared ? pick(kpisFor(everything, compared, together(comparedRetention)), columns) : null,
    spark: trend.map((p) => Object.entries(p.values).reduce((sum, [id, v]) => (chosen.has(id) ? sum + v : sum), 0)),
  }
  return { rows: built, total }
}
