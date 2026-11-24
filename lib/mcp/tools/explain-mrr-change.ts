import { z } from "zod"
import { METRICS, type MetricId } from "@/lib/analytics/metrics-registry"
import { getMrrMovers, type MrrMove, type MrrMoveKind, type MrrMovePlan } from "@/lib/analytics/mrr-movers"
import { addDays } from "@/lib/analytics/range"
import { readRangeNumbers } from "../metrics"
import { billing, count, envelope, instant, money } from "../output"
import { RANGE_INPUT } from "../range"
import { APPS_INPUT, appList, readScope } from "../scope"
import { defineTool } from "../tool"

const DEFAULT_LIMIT = 10
const MOST = 50

/** Each movement and the metric that sums it, in the order MRR moves through them. */
const MOVEMENTS: [MrrMoveKind, MetricId][] = [
  ["new", "newMrr"],
  ["expansion", "expansionMrr"],
  ["contraction", "contractionMrr"],
  ["churned", "churnedMrr"],
]

const plan = (p: MrrMovePlan | null) => (p ? { plan: p.planHandle, billing_period: billing(p.billingPeriod), monthly_price: money(p.monthlyCents) } : null)

function move(m: MrrMove) {
  return {
    app_id: m.appId,
    shop: m.shop,
    at: instant(m.at),
    day: m.date,
    mrr: money(m.amountCents),
    before: plan(m.before),
    after: plan(m.after),
    ...(m.kind === "new" ? { via: m.via } : {}),
    ...(m.kind === "churned" ? { end_reason: m.endReason } : {}),
  }
}

export const explainMrrChangeTool = defineTool({
  name: "explain_mrr_change",
  title: "Explain an MRR change",
  description: [
    "Why MRR moved over a date range: MRR at the start and at the end, the new, expansion, contraction and churned MRR between them (which add up to the change), and the shops behind each, largest first.",
    "Each shop's move has its app, when it happened, the MRR it added or took away, the plan before and after, and for new MRR how the shop started paying (via: subscription, trial, resume or plan_change), for churned MRR what ended it (end_reason: canceled, uninstalled, frozen or replaced).",
    `Lists hold ${DEFAULT_LIMIT} shops per movement unless you ask for up to ${MOST}; moves counts them all. The amounts equal the dashboard's for the same apps and range.`,
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    ...RANGE_INPUT,
    limit: z.number().int().min(1).max(MOST).optional().describe(`How many shops to list for each movement, largest first. Default: ${DEFAULT_LIMIT}.`),
  }),
  async run(ctx, input) {
    const scope = await readScope(ctx, input)
    const { range } = scope
    const limit = input.limit ?? DEFAULT_LIMIT
    const [numbers, movers] = await ctx.read((db) => Promise.all([readRangeNumbers(db, scope.appIds, range, null), getMrrMovers(db, scope.appIds, range)]))
    const k = numbers.kpis

    let cut = false
    const movements = Object.fromEntries(
      MOVEMENTS.map(([kind, metric]) => {
        // Largest first; of equal amounts, the earliest.
        const moves = movers.moves.filter((m) => m.kind === kind).sort((a, b) => b.amountCents - a.amountCents || a.at.getTime() - b.at.getTime())
        if (moves.length > limit) cut = true
        return [kind, { mrr: money(k[metric]), definition: METRICS[metric].description, moves: count(moves.length), largest: moves.slice(0, limit).map(move) }]
      })
    )

    const notes = [...scope.notes, `MRR at the start is its value at the end of ${addDays(range.from, -1)}, the day before the range. New plus expansion, minus contraction and churned, is the change.`]
    if (cut) notes.push(`Each list holds the ${limit} largest moves of its movement, and moves counts them all. Ask for up to ${MOST}, or a shorter range, to see more.`)
    return envelope(
      { apps: appList(scope.apps), mrr_at_start: money(k.mrrStart), mrr_at_end: money(k.mrr), net_new_mrr: money(k.netNewMrr), movements },
      { range, notes }
    )
  },
})
