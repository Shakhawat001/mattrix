import { bucketSeries, seriesByApp, type MetricKey, type SeriesPoint, type DayRow } from "./aggregate"
import type { MetricFormat, MetricId } from "./metrics-registry"
import { bucketLabel, formatDate, type Granularity, type Range } from "./range"
import { MOVEMENT_SERIES, slotColor, type AppSeries, type SeriesDef } from "./series"

// Turns the rollup into what a chart draws: one object per bucket, keyed by series. These are
// plain functions of rows, so they are tested without a browser.

export type Datum = { bucket: string; [key: string]: number | string }

export type ChartData = {
  points: Datum[]
  series: SeriesDef[]
  format: MetricFormat
  /** The same measure over the comparison range, aligned bucket by bucket. Single-series charts only. */
  compare?: { label: string; values: (number | null)[] }
}

/** A bucket's name for a table or tooltip: "Nov 16, 2026", "Week of Nov 16, 2026" or "Nov 2026". */
export function bucketTitle(bucket: string, granularity: Granularity): string {
  if (granularity === "day") return formatDate(bucket)
  if (granularity === "week") return `Week of ${formatDate(bucket)}`
  return bucketLabel(bucket, "month")
}

/** One measure per app per bucket. Apps without a color of their own are summed into "Other". */
export function byApp(rows: DayRow[], range: Range, granularity: Granularity, metric: MetricKey, apps: AppSeries, format: MetricFormat): ChartData {
  const raw = seriesByApp(rows, range, granularity, metric)
  const points = raw.map(({ bucket, values }) => {
    const datum: Datum = { bucket }
    for (const s of apps.series) datum[s.key] = 0
    for (const [appId, value] of Object.entries(values)) datum[apps.keyOf(appId)] = (datum[apps.keyOf(appId)] as number | undefined ?? 0) + value
    return datum
  })
  return { points, series: apps.series, format }
}

export type TotalDef = { key: string; label: string; color: string; read: (point: SeriesPoint) => number }

/** Several measures of all the chosen apps together, one series each. */
export function totals(rows: DayRow[], range: Range, granularity: Granularity, defs: TotalDef[], format: MetricFormat): ChartData {
  const points = bucketSeries(rows, range, granularity).map((p) => {
    const datum: Datum = { bucket: p.bucket }
    for (const d of defs) datum[d.key] = d.read(p)
    return datum
  })
  return { points, series: defs.map(({ key, label, color }) => ({ key, label, color })), format }
}

/** A single measure over time, optionally with the same measure over a comparison range behind it. */
export function single(
  rows: DayRow[],
  range: Range,
  granularity: Granularity,
  def: TotalDef,
  format: MetricFormat,
  compared?: { range: Range; label: string } | null,
): ChartData {
  const data = totals(rows, range, granularity, [def], format)
  if (compared) {
    const behind = bucketSeries(rows, compared.range, granularity).map((p) => def.read(p))
    data.compare = { label: compared.label, values: data.points.map((_, i) => behind[i] ?? null) }
  }
  return data
}

// ---------------------------------------------------------------------------
// Readers for the measures that charts and sparklines share
// ---------------------------------------------------------------------------

export const readers = {
  installs: (p) => p.installs,
  uninstalls: (p) => p.uninstalls,
  negUninstalls: (p) => 0 - p.uninstalls,
  netInstalls: (p) => p.installs - p.uninstalls,
  activeInstalls: (p) => p.activeInstalls,
  newSubs: (p) => p.newSubs,
  canceledSubs: (p) => p.canceledSubs,
  negCanceledSubs: (p) => 0 - p.canceledSubs,
  activeSubs: (p) => p.activeSubs,
  mrr: (p) => p.mrrCents,
  netEarned: (p) => p.netEarnedCents,
  fees: (p) => p.feeCents,
  grossEarned: (p) => p.grossEarnedCents,
  charged: (p) => p.chargedCents,
  refunded: (p) => p.refundedCents,
  trialsStarted: (p) => p.trialsStarted,
  trialsConverted: (p) => p.trialsConverted,
  trialsCanceled: (p) => p.trialsCanceled,
} satisfies Record<string, (p: SeriesPoint) => number>

/** What each KPI's sparkline plots. A metric not listed here (a ratio) has no sparkline. */
export const SPARK: Partial<Record<MetricId, (p: SeriesPoint) => number>> = {
  activeInstalls: readers.activeInstalls,
  installs: readers.installs,
  reinstalls: (p) => p.reinstalls,
  uninstalls: readers.uninstalls,
  uninstallsStoreInactive: (p) => p.uninstallsStoreInactive,
  uninstallsMerchantLeft: (p) => p.uninstalls - p.uninstallsStoreInactive,
  netInstalls: readers.netInstalls,
  deactivations: (p) => p.deactivations,
  reactivations: (p) => p.reactivations,
  activeSubs: readers.activeSubs,
  trialSubs: (p) => p.trialSubs,
  newSubs: readers.newSubs,
  canceledSubs: readers.canceledSubs,
  canceledSubsStoreInactive: (p) => p.canceledSubsStoreInactive,
  canceledSubsMerchantLeft: (p) => p.canceledSubs - p.canceledSubsStoreInactive,
  mrr: readers.mrr,
  trialMrr: (p) => p.trialMrrCents,
  arr: (p) => p.mrrCents * 12,
  newMrr: (p) => p.newMrrCents,
  expansionMrr: (p) => p.expansionMrrCents,
  contractionMrr: (p) => p.contractionMrrCents,
  churnedMrr: (p) => p.churnedMrrCents,
  churnedMrrStoreInactive: (p) => p.churnedMrrStoreInactiveCents,
  churnedMrrMerchantLeft: (p) => p.churnedMrrCents - p.churnedMrrStoreInactiveCents,
  netNewMrr: (p) => p.newMrrCents + p.expansionMrrCents - p.contractionMrrCents - p.churnedMrrCents,
  trialsStarted: readers.trialsStarted,
  trialsConverted: readers.trialsConverted,
  trialsCanceled: readers.trialsCanceled,
  charged: readers.charged,
  grossEarned: readers.grossEarned,
  netEarned: readers.netEarned,
  fees: readers.fees,
  refunded: readers.refunded,
  credits: (p) => p.creditCents,
}

/** The values behind a KPI's sparkline, oldest first. Empty for a metric that has none. */
export function sparkValues(points: SeriesPoint[], metric: MetricId): number[] {
  const read = SPARK[metric]
  return read ? points.map(read) : []
}

// Fixed series for the charts that repeat on several pages, so a measure keeps one hue everywhere.
/** New and expansion MRR above the zero line, contraction and churn below it. */
export const MRR_MOVEMENT: TotalDef[] = MOVEMENT_SERIES.map(({ key, label, color, metric, sign }) => ({ key, label, color, read: (p) => sign * p[metric] || 0 }))

export const INSTALLS_AND_UNINSTALLS: TotalDef[] = [
  { key: "installs", label: "Installs", color: slotColor(0), read: readers.installs },
  { key: "uninstalls", label: "Uninstalls", color: slotColor(1), read: readers.negUninstalls },
]

export const SUBS_AND_CANCELS: TotalDef[] = [
  { key: "newSubs", label: "New subscribers", color: slotColor(0), read: readers.newSubs },
  { key: "canceledSubs", label: "Canceled", color: slotColor(1), read: readers.negCanceledSubs },
]

export const EARNINGS_SPLIT: TotalDef[] = [
  { key: "net", label: "Net earnings", color: slotColor(0), read: readers.netEarned },
  { key: "fees", label: "Shopify fees", color: slotColor(1), read: readers.fees },
]

export const TRIAL_FLOW: TotalDef[] = [
  { key: "started", label: "Started", color: slotColor(0), read: readers.trialsStarted },
  { key: "converted", label: "Converted", color: slotColor(1), read: readers.trialsConverted },
  { key: "canceled", label: "Canceled", color: slotColor(2), read: readers.trialsCanceled },
]
