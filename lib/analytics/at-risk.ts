import { sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { parseTimestamp } from "@/lib/db/timestamps"
import { EVENT } from "@/lib/partner/query"

// What may be lost soon, or may come back, from the subscription periods derive() wrote:
//
//   set to end      paying subscriptions whose cancel takes effect on a later day
//   trials ending   free trials of a paid plan that end in the next 7 days and would then convert
//   frozen          paying subscriptions Shopify froze in the last 90 days that have not come back
//
// Read for a moment, normally now, over the whole history rather than a date range. The periods are
// as the last rebuild left them, so the moment only moves the windows and drops what has ended
// since: a cancel whose day has come, a trial whose end has passed.

const DAY_MS = 86_400_000

/** A trial that ends within this many days is ending soon. */
export const TRIAL_DAYS_AHEAD = 7
/** A subscription frozen within this many days may still come back. */
export const FROZEN_DAYS_BACK = 90

type Plan = {
  appId: string
  shop: string
  planHandle: string | null
  billingPeriod: string | null
  /** The price per month, a yearly price divided by twelve. */
  monthlyCents: number
}

export type SetToEnd = Plan & {
  /** When Shopify first said the subscription is canceled from a later day. */
  scheduledAt: Date
  /** The start of the day the cancel takes effect, in the dashboard's time zone. It pays until then. */
  endsAt: Date
}

export type TrialEnding = Plan & {
  /** When the trial ends and, unless the merchant cancels first, turns into MRR. */
  endsAt: Date
}

export type FrozenSubscription = Plan & {
  frozenAt: Date
}

export type AtRiskList<T> = {
  /** Every one of them. */
  count: number
  /** Their monthly prices together: the MRR set to end, that the trials would add, or that is frozen. */
  mrrCents: number
  /** The first `limit` of them. */
  rows: T[]
}

export type AtRisk = {
  /** The moment the lists are for. */
  at: Date
  /** Soonest end first. */
  setToEnd: AtRiskList<SetToEnd>
  /** Soonest end first. */
  trialsEnding: AtRiskList<TrialEnding>
  /** Latest freeze first. */
  frozen: AtRiskList<FrozenSubscription>
}

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
const inList = (ids: string[]): SQL => (ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
/** A timestamp for a raw query: text with a cast, because the driver cannot encode a Date it has no column for. */
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`

const none = <T>(): AtRiskList<T> => ({ count: 0, mrrCents: 0, rows: [] })

// Raw SQL hands timestamps back as text and bigints as strings, so both are read below.
type Row = {
  app_id: string
  shop: string
  plan_handle: string | null
  billing_period: string | null
  monthly_cents: string | number
  /** The date a list is ordered by: the end, or the freeze. */
  at: string | Date
  scheduled_at?: string | Date
  n: number
  cents: string | number
}

/** Every match counted and summed, with the first `limit` of them, in one statement so the totals and the rows agree. */
async function readList<T>(db: Queryable, matches: SQL, order: SQL, limit: number, toRow: (r: Row, plan: Plan) => T): Promise<AtRiskList<T>> {
  const rows = await db.execute<Row>(sql`
    SELECT m.*, count(*) OVER ()::int AS n, sum(m.monthly_cents) OVER ()::bigint AS cents
    FROM (${matches}) m
    ORDER BY ${order}
    LIMIT ${limit}
  `)
  return {
    count: rows[0]?.n ?? 0,
    mrrCents: Number(rows[0]?.cents ?? 0),
    rows: rows.map((r) => toRow(r, { appId: r.app_id, shop: r.shop, planHandle: r.plan_handle, billingPeriod: r.billing_period, monthlyCents: Number(r.monthly_cents) })),
  }
}

export async function getAtRisk(db: Queryable, appIds: string[], now: Date = new Date(), limit = 10): Promise<AtRisk> {
  if (appIds.length === 0) return { at: now, setToEnd: none(), trialsEnding: none(), frozen: none() }
  const take = Math.max(1, Math.floor(limit))
  const t = ts(now)
  const ahead = ts(new Date(now.getTime() + TRIAL_DAYS_AHEAD * DAY_MS))
  const back = ts(new Date(now.getTime() - FROZEN_DAYS_BACK * DAY_MS))
  // A period running at the moment, on a paid plan.
  const running = sql`app_id IN ${inList(appIds)} AND monthly_cents > 0 AND started_at <= ${t} AND (ended_at IS NULL OR ended_at > ${t})`

  const [setToEnd, trialsEnding, frozen] = await Promise.all([
    readList(
      db,
      sql`
        SELECT app_id, shop, plan_handle, billing_period, monthly_cents, cancel_effective_at AS at, cancel_scheduled_at AS scheduled_at
        FROM subscriptions
        WHERE ${running} AND (trial_ends_at IS NULL OR converted_at <= ${t})
          AND cancel_scheduled_at <= ${t} AND cancel_effective_at > ${t}
      `,
      sql`m.at, m.monthly_cents DESC, m.shop, m.app_id`,
      take,
      (r, plan): SetToEnd => ({ ...plan, scheduledAt: parseTimestamp(r.scheduled_at as string | Date), endsAt: parseTimestamp(r.at) }),
    ),
    readList(
      db,
      // A trial whose subscription is set to end before the trial does will not convert.
      sql`
        SELECT app_id, shop, plan_handle, billing_period, monthly_cents, trial_ends_at AS at
        FROM subscriptions
        WHERE ${running} AND (converted_at IS NULL OR converted_at > ${t})
          AND trial_ends_at > ${t} AND trial_ends_at <= ${ahead}
          AND (cancel_effective_at IS NULL OR cancel_scheduled_at > ${t} OR cancel_effective_at > trial_ends_at)
      `,
      sql`m.at, m.monthly_cents DESC, m.shop, m.app_id`,
      take,
      (r, plan): TrialEnding => ({ ...plan, endsAt: parseTimestamp(r.at) }),
    ),
    readList(
      db,
      // Paying when it was frozen (paidFrom in derive.ts), and nothing since: no resume or new
      // subscription, and no uninstall or cancel, after which it cannot come back. On the same
      // instant derive() reads an uninstall after a freeze and a cancel before it.
      sql`
        SELECT s.app_id, s.shop, s.plan_handle, s.billing_period, s.monthly_cents, s.ended_at AS at
        FROM subscriptions s
        WHERE s.app_id IN ${inList(appIds)} AND s.end_reason = 'frozen' AND s.monthly_cents > 0
          AND s.ended_at <= ${t} AND s.ended_at > ${back}
          AND CASE WHEN s.trial_ends_at IS NULL THEN s.started_at < s.ended_at ELSE s.converted_at IS NOT NULL AND greatest(s.started_at, s.converted_at) < s.ended_at END
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions n
            WHERE n.app_id = s.app_id AND n.shop = s.shop AND n.id <> s.id AND n.started_at >= s.ended_at AND n.started_at <= ${t}
          )
          AND NOT EXISTS (
            SELECT 1 FROM events e
            WHERE e.app_id = s.app_id AND e.shop = s.shop AND e.occurred_at <= ${t}
              AND ((e.type = ${EVENT.UNINSTALLED} AND e.occurred_at >= s.ended_at) OR (e.type = ${EVENT.SUB_CANCELED} AND e.occurred_at > s.ended_at))
          )
      `,
      sql`m.at DESC, m.monthly_cents DESC, m.shop, m.app_id`,
      take,
      (r, plan): FrozenSubscription => ({ ...plan, frozenAt: parseTimestamp(r.at) }),
    ),
  ])

  return { at: now, setToEnd, trialsEnding, frozen }
}
