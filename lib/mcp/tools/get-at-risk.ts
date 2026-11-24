import { z } from "zod"
import { FROZEN_DAYS_BACK, getAtRisk, TRIAL_DAYS_AHEAD } from "@/lib/analytics/at-risk"
import { atRiskMetricAnswer } from "../metrics"
import { billing, count, days, envelope, instant, money } from "../output"
import { APPS_INPUT, appList, sourceNotes } from "../scope"
import { defineTool } from "../tool"

const DEFAULT_LIMIT = 10
const MOST = 100
const DAY_MS = 86_400_000

const plan = (r: { appId: string; shop: string; planHandle: string | null; billingPeriod: string | null; monthlyCents: number }) => ({
  app_id: r.appId,
  shop: r.shop,
  plan: r.planHandle,
  billing_period: billing(r.billingPeriod),
  monthly_price: money(r.monthlyCents),
})

export const getAtRiskTool = defineTool({
  name: "get_at_risk",
  title: "At risk",
  description: [
    "What may be lost soon or may come back, for the chosen apps together, as the at-risk card on the dashboard's overviews shows it. Read for now, not for a date range.",
    "set_to_end: paying subscriptions whose cancel Shopify has scheduled for a later day, with the MRR they take and the day each cancel takes effect.",
    `trials_ending_soon: free trials of a paid plan that end in the next ${TRIAL_DAYS_AHEAD} days, with what they would add to MRR if they convert.`,
    `frozen: paying subscriptions Shopify froze in the last ${FROZEN_DAYS_BACK} days (the store closed or stopped paying Shopify) that have not come back, with the MRR unfreezing would bring back.`,
    `Lists ${DEFAULT_LIMIT} shops in each part unless you ask for up to ${MOST}; the counts and sums cover them all. get_shop_timeline gives any shop's history.`,
  ].join(" "),
  input: z.object({
    ...APPS_INPUT,
    limit: z.number().int().min(1).max(MOST).optional().describe(`How many shops to list in each part. Default: ${DEFAULT_LIMIT}.`),
  }),
  async run(ctx, input) {
    const apps = await ctx.apps(input.app_ids)
    const limit = input.limit ?? DEFAULT_LIMIT
    const risk = await ctx.read((db) => getAtRisk(db, apps.map((a) => a.id), ctx.now, limit))
    const now = ctx.now.getTime()
    const { setToEnd, trialsEnding, frozen } = risk

    const notes = await sourceNotes(ctx, apps)
    notes.push("Read at as_of from the subscriptions as each app's last rebuild left them (last_built_at in list_apps). A cancel whose day has come, or a trial that has ended, since that rebuild is already left out.")
    if ([setToEnd, trialsEnding, frozen].some((list) => list.count > list.rows.length)) {
      notes.push(`Each list holds at most ${limit} ${limit === 1 ? "shop" : "shops"}, and its count covers them all. Ask for up to ${MOST} with limit.`)
    }

    return envelope(
      {
        apps: appList(apps),
        as_of: instant(risk.at),
        set_to_end: {
          metric: atRiskMetricAnswer("mrrSetToEnd", setToEnd.mrrCents),
          subscriptions: count(setToEnd.count),
          ending_soonest: setToEnd.rows.map((r) => ({
            ...plan(r),
            cancel_scheduled_at: instant(r.scheduledAt),
            cancel_effective_on: r.endsAt.toISOString().slice(0, 10),
            days_left: days(Math.max(0, (r.endsAt.getTime() - now) / DAY_MS)),
          })),
        },
        trials_ending_soon: {
          metric: atRiskMetricAnswer("trialsEndingSoon", trialsEnding.count),
          mrr_if_all_convert: money(trialsEnding.mrrCents),
          ending_soonest: trialsEnding.rows.map((r) => ({ ...plan(r), ends_at: instant(r.endsAt), days_left: days(Math.max(0, (r.endsAt.getTime() - now) / DAY_MS)) })),
        },
        frozen: {
          metric: atRiskMetricAnswer("frozenMrr", frozen.mrrCents),
          subscriptions: count(frozen.count),
          latest: frozen.rows.map((r) => ({ ...plan(r), frozen_at: instant(r.frozenAt), days_frozen: days(Math.max(0, (now - r.frozenAt.getTime()) / DAY_MS)) })),
        },
      },
      { notes }
    )
  },
})
