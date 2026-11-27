import { z } from "zod"
import type { MetricId } from "@/lib/analytics/metrics-registry"
import { getOpenTrials } from "@/lib/analytics/open-trials"
import { getTrialStats } from "@/lib/analytics/queries"
import { metricAnswer, readRangeNumbers } from "../metrics"
import { billing, count, days, envelope, instant, money, NOTES } from "../output"
import { COMPARE_INPUT, RANGE_INPUT } from "../range"
import { APPS_INPUT, appList, readScope } from "../scope"
import { defineTool } from "../tool"

/** The trials page's numbers, then the trials running at the end of the range. */
const TRIALS: MetricId[] = ["trialsStarted", "trialsConverted", "trialsCanceled", "trialConversion", "trialSubs", "trialMrr"]
const DEFAULT_LIMIT = 10
const MOST = 100
const DAY_MS = 86_400_000

export const getTrialsTool = defineTool({
  name: "get_trials",
  title: "Trials",
  description: [
    "Free trials for the chosen apps together: the dashboard's trial numbers for a date range (started, converted, canceled, trial to paid, and in trial at the end), what became of the trials that started in the range, and the trials of paid plans running now, ending soonest first.",
    "A trial converts when it ends with the subscription still open, so the open trials are the ones that turn into MRR next unless they are canceled first. Each has its app, shop, plan and monthly price, when it started and when it ends.",
    `Lists ${DEFAULT_LIMIT} open trials unless you ask for up to ${MOST}; total counts them all. The open trials do not depend on the range.`,
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    ...RANGE_INPUT,
    ...COMPARE_INPUT,
    limit: z.number().int().min(1).max(MOST).optional().describe(`How many open trials to list, ending soonest first. Default: ${DEFAULT_LIMIT}.`),
  }),
  async run(ctx, input) {
    const scope = await readScope(ctx, input)
    const { appIds, range, compared } = scope
    const [numbers, started, open] = await ctx.read((db) =>
      Promise.all([readRangeNumbers(db, appIds, range, compared, scope.timeZone), getTrialStats(db, appIds, range, scope.timeZone), getOpenTrials(db, appIds, input.limit ?? DEFAULT_LIMIT)])
    )

    const metrics = TRIALS.map((id) => metricAnswer(id, numbers.kpis, numbers.compared))
    const now = ctx.now.getTime()
    const notes = [
      ...scope.notes,
      "started_in_range follows the trials that started in the range up to today. The trial numbers in metrics count each start, conversion and cancel on the day it happened.",
    ]
    if (open.total > 0) {
      notes.push("The open trials are as of each app's last rebuild (last_built_at in list_apps). One whose end has passed since shows 0 days left, and the next rebuild counts it as converted unless it was canceled.")
    }
    if (metrics.some((m) => m.value === null || m.previous === null) || started.medianDaysToConvert === null) notes.push(NOTES.nullMeansNothingToDivide)

    return envelope(
      {
        apps: appList(scope.apps),
        metrics,
        started_in_range: {
          started: count(started.started),
          converted: count(started.converted),
          canceled: count(started.canceled),
          still_running: count(started.open),
          median_days_to_convert: days(started.medianDaysToConvert),
        },
        open_trials: {
          total: count(open.total),
          mrr_if_all_convert: money(open.monthlyCents),
          ending_soonest: open.trials.map((t) => ({
            app_id: t.appId,
            shop: t.shop,
            plan: t.planHandle,
            billing_period: billing(t.billingPeriod),
            monthly_price: money(t.monthlyCents),
            started_at: instant(t.startedAt),
            ends_at: instant(t.endsAt),
            days_left: days(Math.max(0, (t.endsAt.getTime() - now) / DAY_MS)),
          })),
        },
      },
      { timeZone: scope.timeZone, range, compared, notes }
    )
  },
})
