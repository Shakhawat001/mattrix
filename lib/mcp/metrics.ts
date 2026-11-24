import { z } from "zod"
import { addRetention, FLOW_KEYS, kpis, kpisFor, STOCK_KEYS, type DayRow, type Flows, type Kpis, type Retention, type Stocks } from "@/lib/analytics/aggregate"
import { BETTER, UNIT } from "@/lib/analytics/metrics-doc"
import { COHORT_METRICS, METRICS, type CohortMetricId, type MetricDef, type MetricId } from "@/lib/analytics/metrics-registry"
import { getDayRows, getRetention } from "@/lib/analytics/queries"
import type { Range } from "@/lib/analytics/range"
import type { Queryable } from "@/lib/db/client"
import { describeChange, NONE } from "@/lib/format"
import { metricValue, type Count, type Days, type Money, type Percent } from "./output"

// The registry's numbers as the tools write them, worked out the way the dashboard's pages work
// them out (loadDashboard in lib/analytics/scope.ts): the daily rollup for the range and the range
// it is compared with, and what became of the shops present at the start of each. Nothing here
// names a metric, so one added to the registry is served with no change.

/** The id of every metric of a range, in the registry's order. */
export const RANGE_METRIC_IDS = Object.keys(METRICS) as [MetricId, ...MetricId[]]

/** The input that picks metrics by id. */
export function metricsInput(defaults: readonly MetricId[]) {
  return z
    .array(z.enum(RANGE_METRIC_IDS))
    .min(1)
    .max(RANGE_METRIC_IDS.length)
    .optional()
    .describe(`Metric ids, as get_definitions lists them. Default: ${defaults.join(", ")}.`)
}

export type RangeNumbers = {
  /** Rollup rows from the day before the earlier range to the end of the range. */
  rows: DayRow[]
  /** What became of the shops present at the start of the range, the apps together. */
  retention: Retention
  kpis: Kpis
  /** The same for the compared range, or null when nothing is compared. */
  compared: Kpis | null
}

/** The KPIs of the apps for a range and for the range it is compared with, from the reads and sums loadDashboard uses. */
export async function readRangeNumbers(db: Queryable, appIds: string[], range: Range, compared: Range | null): Promise<RangeNumbers> {
  // One read covers the range and the comparison range, and the day before each.
  const from = compared && compared.from < range.from ? compared.from : range.from
  const [rows, retentionByApp, comparedByApp] = await Promise.all([
    getDayRows(db, appIds, { from, to: range.to }),
    getRetention(db, appIds, range),
    compared ? getRetention(db, appIds, compared) : null,
  ])
  const retention = addRetention([...retentionByApp.values()])
  return {
    rows,
    retention,
    kpis: kpisFor(rows, range, retention),
    compared: compared && comparedByApp ? kpisFor(rows, compared, addRetention([...comparedByApp.values()])) : null,
  }
}

/**
 * The metrics that follow the shops present at the start of a range (getRetention) as well as the
 * rollup: those kpis() leaves empty without them. Found by asking kpis() itself, with made-up
 * figures that give every metric a value, so a rate added later is found too.
 */
export const READS_RETENTION: ReadonlySet<MetricId> = (() => {
  const flows = Object.fromEntries(FLOW_KEYS.map((key) => [key, 1])) as Flows
  const start = Object.fromEntries(STOCK_KEYS.map((key) => [key, 1])) as Stocks
  const end = Object.fromEntries(STOCK_KEYS.map((key) => [key, 2])) as Stocks
  const kept: Retention = { startInstalls: 2, keptInstalls: 1, startSubs: 2, keptSubs: 1, startMrr: 2, endMrr: 1, keptMrr: 1 }
  const without = kpis(flows, start, end, 30, null)
  const withRetention = kpis(flows, start, end, 30, kept)
  return new Set(RANGE_METRIC_IDS.filter((id) => without[id] === null && withRetention[id] !== null))
})()

type Figure = Money | Percent | Count | Days

export type MetricChange = {
  /** Value minus previous, written the way the value is. */
  difference: Figure | null
  /** The dashboard's text for it: a percentage for counts, amounts and days, points for a rate. Null when the previous value was 0, which has no percentage. */
  formatted: string | null
  /** Whether it is an improvement. Null when nothing changed, or when neither direction is better. */
  better: boolean | null
}

export type MetricAnswer = {
  id: string
  label: string
  unit: string
  value: Figure | null
  /** The value over the compared range. Only when the tool compares. */
  previous?: Figure | null
  /** Null when either value is null. Only when the tool compares. */
  change?: MetricChange | null
  better_when: string
  definition: string
}

function answer(id: string, def: MetricDef, value: number | null, compared?: { previous: number | null }): MetricAnswer {
  return {
    id,
    label: def.label,
    unit: UNIT[def.format],
    value: metricValue(value, def.format),
    ...(compared ? { previous: metricValue(compared.previous, def.format), change: changeOf(value, compared.previous, def) } : {}),
    better_when: BETTER[def.good],
    definition: def.description,
  }
}

export function changeOf(value: number | null, previous: number | null, def: Pick<MetricDef, "format" | "good">): MetricChange | null {
  if (value === null || previous === null) return null
  const difference = value - previous
  const flat = Math.abs(difference) < 1e-9
  const { text } = describeChange(value, previous, def)
  return {
    difference: metricValue(flat ? 0 : difference, def.format),
    formatted: text === NONE ? null : text,
    better: flat || def.good === "none" ? null : (difference > 0) === (def.good === "up"),
  }
}

/** One metric of a range, and its previous value and change when `compared` is given. */
export function metricAnswer(id: MetricId, current: Kpis, compared: Kpis | null): MetricAnswer {
  return answer(id, METRICS[id], current[id], compared ? { previous: compared[id] } : undefined)
}

/** One of the numbers that follow a group of shops up to today (COHORT_METRICS). They have no comparison. */
export function cohortMetricAnswer(id: CohortMetricId, value: number | null): MetricAnswer {
  return answer(id, COHORT_METRICS[id], value)
}
