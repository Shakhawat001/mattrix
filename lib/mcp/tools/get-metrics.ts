import { z } from "zod"
import type { MetricId } from "@/lib/analytics/metrics-registry"
import { metricAnswer, metricsInput, readRangeNumbers } from "../metrics"
import { envelope, NOTES } from "../output"
import { COMPARE_INPUT, RANGE_INPUT } from "../range"
import { APPS_INPUT, appList, readScope } from "../scope"
import { defineTool } from "../tool"

/** The overview page's headline numbers, with new installs and uninstalls. */
const DEFAULT_METRICS: MetricId[] = ["mrr", "netNewMrr", "activeSubs", "activeInstalls", "installs", "uninstalls", "nrr", "subChurnRate", "trialConversion", "charged"]

export const getMetricsTool = defineTool({
  name: "get_metrics",
  title: "Metrics for a range",
  description: [
    "Any of the dashboard's numbers for a date range, for the chosen apps together (default: every app that is not hidden), optionally compared with the period before or the same days a year earlier.",
    "Each metric has its id, label, unit, value, better_when and definition; with a comparison also previous and change (difference, the dashboard's change text, and whether it is better).",
    "Without metrics it returns the overview's headline numbers. Ask for any other by id: get_definitions lists them all.",
    "Stocks such as MRR, subscribers and active installs are their value at the end of the range; flows such as installs and new MRR add up over it; rates such as subscriber churn follow the shops present at its start.",
    "The figures equal the dashboard's for the same apps and range. For one app at a time, call it once per app.",
  ].join(" "),
  input: z.object({ ...APPS_INPUT, ...RANGE_INPUT, ...COMPARE_INPUT, metrics: metricsInput(DEFAULT_METRICS) }),
  async run(ctx, input) {
    const scope = await readScope(ctx, input, { earnings: true })
    const numbers = await ctx.read((db) => readRangeNumbers(db, scope.appIds, scope.range, scope.compared))
    const metrics = [...new Set(input.metrics ?? DEFAULT_METRICS)].map((id) => metricAnswer(id, numbers.kpis, numbers.compared))

    const notes = [...scope.notes]
    if (metrics.some((m) => m.value === null || m.previous === null)) notes.push(NOTES.nullMeansNothingToDivide)
    return envelope({ apps: appList(scope.apps), metrics }, { range: scope.range, compared: scope.compared, notes })
  },
})
