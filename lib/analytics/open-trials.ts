import { sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { parseTimestamp, parseTimestampOrNull } from "@/lib/db/timestamps"

// The free trials of paid plans running now, ending soonest first: the shops behind the In trial
// number. A trial runs while its subscription is open and has not turned into money, as derive()
// left it at the last rebuild, so the count and the sum equal the rollup's trialSubs and
// trialMrrCents on its last day. A trial of a free plan would add nothing to MRR and is not one.

export type OpenTrial = {
  appId: string
  shop: string
  /** When the trial began. A plan change during a trial keeps the trial, so this can be before the plan's start. */
  startedAt: Date | null
  endsAt: Date
  planHandle: string | null
  billingPeriod: string | null
  /** The plan's price per month, a yearly price divided by twelve: what the shop adds to MRR if the trial converts. */
  monthlyCents: number
}

export type OpenTrials = {
  /** Every open trial of these apps. */
  total: number
  /** What they would add to MRR if every one converted. */
  monthlyCents: number
  /** The `limit` trials ending soonest. */
  trials: OpenTrial[]
}

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
const inList = (ids: string[]): SQL => (ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)

export async function getOpenTrials(db: Queryable, appIds: string[], limit = 10): Promise<OpenTrials> {
  if (appIds.length === 0) return { total: 0, monthlyCents: 0, trials: [] }
  const open = sql`
    SELECT app_id, shop, trial_ends_at, plan_handle, billing_period, monthly_cents
    FROM subscriptions
    WHERE app_id IN ${inList(appIds)} AND ended_at IS NULL AND monthly_cents > 0 AND trial_ends_at IS NOT NULL AND converted_at IS NULL
  `

  const [[totals], rows] = await Promise.all([
    db.execute<{ n: number; cents: string }>(sql`SELECT count(*)::int AS n, coalesce(sum(monthly_cents), 0)::bigint AS cents FROM (${open}) o`),
    // Raw SQL hands timestamps back as text, so they are read into Dates below.
    db.execute<{
      app_id: string; shop: string; trial_ends_at: string | Date; plan_handle: string | null; billing_period: string | null; monthly_cents: string | number; started_at: string | Date | null
    }>(sql`
      SELECT o.*, (SELECT max(t.started_at) FROM trials t WHERE t.app_id = o.app_id AND t.shop = o.shop AND t.outcome = 'open') AS started_at
      FROM (${open}) o
      ORDER BY o.trial_ends_at, o.shop, o.app_id
      LIMIT ${limit}
    `),
  ])

  return {
    total: totals.n,
    monthlyCents: Number(totals.cents),
    trials: rows.map((r) => ({
      appId: r.app_id,
      shop: r.shop,
      startedAt: parseTimestampOrNull(r.started_at),
      endsAt: parseTimestamp(r.trial_ends_at),
      planHandle: r.plan_handle,
      billingPeriod: r.billing_period,
      monthlyCents: Number(r.monthly_cents),
    })),
  }
}
