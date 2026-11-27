import { z } from "zod"
import { addRetention, kpisFor, noRetention, type DayRow, type Retention } from "@/lib/analytics/aggregate"
import { BETTER, UNIT } from "@/lib/analytics/metrics-doc"
import { METRICS, type MetricId } from "@/lib/analytics/metrics-registry"
import { getDayRows, getRetention } from "@/lib/analytics/queries"
import { addDays, autoGranularity, bucketsIn, nextBucket, type Granularity, type Range } from "@/lib/analytics/range"
import { formatInt } from "@/lib/format"
import { metricsInput, READS_RETENTION } from "../metrics"
import { envelope, metricValue, NOTES } from "../output"
import { RANGE_INPUT } from "../range"
import { APPS_INPUT, appList, readScope } from "../scope"
import { defineTool, ToolError } from "../tool"

const DEFAULT_METRICS: MetricId[] = ["mrr", "activeInstalls"]
/** Points times metrics times series. Past this an answer stops being readable. */
const MOST_VALUES = 1500
/** A rate that follows the starting shops reads them again for every point. */
const MOST_POINTS_WITH_RATES = 100

export type Bucket = Range & { bucket: string }

/** Every bucket the range touches, each cut to its days inside the range. */
export function bucketRanges(range: Range, granularity: Granularity): Bucket[] {
  return bucketsIn(range, granularity).map((bucket) => {
    const last = addDays(nextBucket(bucket, granularity), -1)
    return { bucket, from: bucket < range.from ? range.from : bucket, to: last > range.to ? range.to : last }
  })
}

export const getTimeseriesTool = defineTool({
  name: "get_timeseries",
  title: "Metrics over time",
  description: [
    "The dashboard's numbers by day, week or month across a date range, for the chosen apps together or for each app on its own: what the dashboard's charts draw.",
    "Each point is its days inside the range, read the way get_metrics reads a range: flows add up over them, stocks such as MRR are their value at the end of the last one, and rates follow the shops present at the start.",
    "Without metrics it returns MRR and active installs. Without a granularity it picks the dashboard's: days up to 45 days, weeks up to 270, months beyond.",
    `An answer holds at most ${formatInt(MOST_VALUES)} values (points times metrics times apps), and at most ${MOST_POINTS_WITH_RATES} points when it includes a rate such as nrr or subChurnRate. Past that, ask for a coarser granularity or a shorter range.`,
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    ...RANGE_INPUT,
    metrics: metricsInput(DEFAULT_METRICS),
    granularity: z.enum(["day", "week", "month"]).optional().describe("day, week (Monday to Sunday) or month. Default: the dashboard's choice for the range."),
    per_app: z.boolean().optional().describe("true for one series per app, false for the apps together. Default: false."),
  }),
  async run(ctx, input) {
    const scope = await readScope(ctx, input, { earnings: true })
    const { range } = scope
    const granularity = input.granularity ?? autoGranularity(range)
    const ids = [...new Set(input.metrics ?? DEFAULT_METRICS)]
    const buckets = bucketRanges(range, granularity)
    const series = input.per_app ? Math.max(1, scope.apps.length) : 1

    const values = buckets.length * ids.length * series
    if (values > MOST_VALUES) {
      throw new ToolError(`That is ${formatInt(values)} values (${buckets.length} points, ${ids.length} metrics, ${series} series), more than ${formatInt(MOST_VALUES)}. Ask for a coarser granularity, a shorter range, fewer metrics or the apps together.`)
    }
    const rates = ids.filter((id) => READS_RETENTION.has(id))
    if (rates.length > 0 && buckets.length > MOST_POINTS_WITH_RATES) {
      throw new ToolError(
        `${rates.join(", ")} ${rates.length === 1 ? "follows" : "follow"} the shops present at the start of each point, so at most ${MOST_POINTS_WITH_RATES} points can be asked for with ${rates.length === 1 ? "it" : "them"}, and this is ${buckets.length}. Ask for a coarser granularity or a shorter range.`
      )
    }

    const { rows, retention } = await ctx.read(async (db) => {
      const [rows, retention] = await Promise.all([
        getDayRows(db, scope.appIds, range),
        rates.length > 0 ? Promise.all(buckets.map((b) => getRetention(db, scope.appIds, b, scope.timeZone))) : null,
      ])
      return { rows, retention }
    })

    // The points of one series: its apps' rollup rows, and what became of their starting shops at each point.
    const pointsOf = (own: DayRow[], keptAt: (i: number) => Retention | null) =>
      buckets.map((b, i) => {
        const k = kpisFor(own, b, keptAt(i))
        return { bucket: b.bucket, from: b.from, to: b.to, values: Object.fromEntries(ids.map((id) => [id, metricValue(k[id], METRICS[id].format)])) }
      })

    const head = {
      granularity,
      apps: appList(scope.apps),
      metrics: ids.map((id) => ({ id, label: METRICS[id].label, unit: UNIT[METRICS[id].format], better_when: BETTER[METRICS[id].good] })),
    }
    const notes = [
      ...scope.notes,
      `Each point covers the days from its from to its to, both included, so the first and the last can be shorter than a full ${granularity}. bucket is the ${granularity === "day" ? "day itself" : `first day of the ${granularity}`}.`,
    ]
    const withNulls = (points: ReturnType<typeof pointsOf>) => points.some((p) => Object.values(p.values).some((v) => v === null))

    if (input.per_app) {
      const byApp = scope.apps.map((a) => ({
        app_id: a.id,
        name: a.label,
        points: pointsOf(
          rows.filter((r) => r.appId === a.id),
          (i) => (retention ? (retention[i].get(a.id) ?? noRetention()) : null)
        ),
      }))
      if (byApp.some((s) => withNulls(s.points))) notes.push(NOTES.nullMeansNothingToDivide)
      return envelope({ ...head, by_app: byApp }, { timeZone: scope.timeZone, range, notes })
    }

    const points = pointsOf(rows, (i) => (retention ? addRetention([...retention[i].values()]) : null))
    if (withNulls(points)) notes.push(NOTES.nullMeansNothingToDivide)
    return envelope({ ...head, points }, { timeZone: scope.timeZone, range, notes })
  },
})
