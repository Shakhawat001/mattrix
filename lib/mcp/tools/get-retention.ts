import { z } from "zod"
import { cohortRetention, type CohortRow } from "@/lib/analytics/aggregate"
import { COHORT_METRICS, type MetricId } from "@/lib/analytics/metrics-registry"
import { getStays } from "@/lib/analytics/queries"
import { autoGranularity } from "@/lib/analytics/range"
import { getRevenueCohorts, type RevenueCohortRow } from "@/lib/analytics/revenue-cohorts"
import { metricAnswer, readRangeNumbers } from "../metrics"
import { count, envelope, money, NOTES, percent } from "../output"
import { COMPARE_INPUT, RANGE_INPUT } from "../range"
import { APPS_INPUT, appList, readScope } from "../scope"
import { defineTool } from "../tool"

/** The retention page's numbers. */
const RETENTION: MetricId[] = ["nrr", "grr", "subChurnRate", "revenueChurnRate", "uninstallRate", "canceledSubs", "newSubs", "trialSubs"]
/** The cohort tables follow each cohort for this many weeks or months, as the dashboard's do. */
const PERIODS = 12
/** The latest cohorts kept in an answer: a year of weeks, four years of months. */
const MOST_COHORTS = 52

/** A cohort's cells up to the last period that has fully passed. The ones after it are empty in the dashboard's table. */
function passed<T>(cells: (T | null)[]): T[] {
  const end = cells.indexOf(null)
  return (end === -1 ? cells : cells.slice(0, end)) as T[]
}

export const getRetentionTool = defineTool({
  name: "get_retention",
  title: "Retention",
  description: [
    "Who stayed and who left, as the dashboard's retention page shows it, for the chosen apps together.",
    "Returns the retention numbers for a date range (net and gross revenue retention, subscriber and revenue churn, uninstall rate, with an optional comparison), the starting group they are built on (the installs, subscribers and MRR present at the start of the range and what was kept by its end), install cohorts (the shops that installed in each week or month of the range and the share still installed at the end of each later one), and revenue cohorts (the shops that first started paying in each month of the range and the share of their starting MRR they still pay at the end of each later month).",
    `Each cohort's list starts with its own week or month and goes on for up to ${PERIODS} periods, up to today; a period is given once it has fully passed. At most the latest ${MOST_COHORTS} cohorts of each kind are returned.`,
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    ...RANGE_INPUT,
    ...COMPARE_INPUT,
    cohort_by: z.enum(["week", "month"]).optional().describe("Install cohorts by week or by month. Default: months for a range over 270 days, weeks otherwise, as on the dashboard. Revenue cohorts are always by month."),
  }),
  async run(ctx, input) {
    const scope = await readScope(ctx, input)
    const { appIds, range, compared } = scope
    // Weeks unless the dashboard would chart the range by month: a day's worth of installs is too few to read a rate from.
    const unit = input.cohort_by ?? (autoGranularity(range) === "month" ? "month" : "week")
    const [numbers, stays, revenue] = await ctx.read((db) => Promise.all([readRangeNumbers(db, appIds, range, compared, scope.timeZone), getStays(db, appIds, range, scope.timeZone), getRevenueCohorts(db, appIds, range, scope.timeZone, ctx.now, PERIODS)]))
    const installCohorts: CohortRow[] = cohortRetention(stays, unit, ctx.now, scope.timeZone, PERIODS)

    const metrics = RETENTION.map((id) => metricAnswer(id, numbers.kpis, numbers.compared))
    const r = numbers.retention
    const notes = [...scope.notes, "The rates follow the starting group: the shops present at the first moment of the range, and what became of exactly those shops by its end."]
    for (const [kind, total] of [["install", installCohorts.length], ["revenue", revenue.length]] as const) {
      if (total > MOST_COHORTS) notes.push(`There are ${total} ${kind} cohorts in this range; the latest ${MOST_COHORTS} are shown. Ask for a shorter range${kind === "install" ? " or monthly cohorts" : ""} to see the rest.`)
    }
    const revenueRows: RevenueCohortRow[] = revenue.slice(-MOST_COHORTS)
    if (metrics.some((m) => m.value === null || m.previous === null) || revenueRows.some((row) => row.cells.some((c) => c !== null && c.share === null))) notes.push(NOTES.nullMeansNothingToDivide)

    return envelope(
      {
        apps: appList(scope.apps),
        metrics,
        starting_group: {
          installs_at_start: count(r.startInstalls),
          installs_kept: count(r.keptInstalls),
          subscribers_at_start: count(r.startSubs),
          subscribers_kept: count(r.keptSubs),
          mrr_at_start: money(r.startMrr),
          mrr_at_end: money(r.endMrr),
          mrr_kept: money(r.keptMrr),
        },
        install_cohorts: {
          by: unit,
          cohorts: installCohorts.slice(-MOST_COHORTS).map((row) => ({ cohort: row.cohort, installs: count(row.size), still_installed: passed(row.cells).map((share) => percent(share)) })),
        },
        revenue_cohorts: {
          definition: COHORT_METRICS.cohortMrrRetention.description,
          cohorts: revenueRows.map((row) => ({
            cohort: row.cohort,
            shops: count(row.shops),
            mrr_at_start: money(row.startMrr),
            months: passed(row.cells).map((c) => ({ mrr: money(c.mrr), paying_shops: count(c.shops), share: percent(c.share) })),
          })),
        },
      },
      { timeZone: scope.timeZone, range, compared, notes }
    )
  },
})
