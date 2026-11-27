import { sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { endOfDay, startOfDay, todayIn } from "@/lib/time-zone"
import { addDays, nextBucket, type Range } from "./range"

// Revenue cohorts: the shops that first started paying in each month, and how much of what they
// started with they still pay at the end of every month after. "Paying" means what it means
// everywhere else: a monthly price above zero, with a free trial counting from its conversion.
// A shop in two apps is two customers.

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
const inList = (ids: string[]): SQL => (ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)
const ts = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`

export type RevenueCohortCell = {
  /** What the cohort's shops pay at the end of the month, upgrades and returns included. */
  mrr: number
  /** How many of them pay anything then. */
  shops: number
  /** `mrr` over the cohort's starting MRR. Net, so upgrades can take it past 1. */
  share: number | null
}

export type RevenueCohortRow = {
  /** The first day of the month the shops first started paying. */
  cohort: string
  shops: number
  /** What the shops paid when each of them first started paying. */
  startMrr: number
  /** Month 0 (the cohort's own), then 1, 2 and on. Null until that month has fully passed. */
  cells: (RevenueCohortCell | null)[]
}

export type CohortStart = { cohort: string; shops: number; startMrr: number }
export type CohortHeld = { cohort: string; k: number; shops: number; mrr: number }

/**
 * The table's rows from what the query counted: each cohort's start, and what it held at the end
 * of month k. A cell stays empty until its month has fully passed, the rule the install cohorts
 * use, so a recent cohort has a short row.
 */
export function revenueCohortRows(starts: CohortStart[], held: CohortHeld[], today: string, periods = 12): RevenueCohortRow[] {
  const heldAt = new Map(held.map((h) => [`${h.cohort}:${h.k}`, h]))
  return [...starts]
    .sort((a, b) => (a.cohort < b.cohort ? -1 : 1))
    .map((start) => {
      const cells: (RevenueCohortCell | null)[] = []
      let monthStart = start.cohort
      for (let k = 0; k < periods; k++) {
        const monthEnd = nextBucket(monthStart, "month") // the first day after the month
        if (monthEnd > addDays(today, 1)) {
          cells.push(null)
        } else {
          const h = heldAt.get(`${start.cohort}:${k}`)
          const mrr = h?.mrr ?? 0
          cells.push({ mrr, shops: h?.shops ?? 0, share: start.startMrr > 0 ? mrr / start.startMrr : null })
        }
        monthStart = monthEnd
      }
      return { cohort: start.cohort, shops: start.shops, startMrr: start.startMrr, cells }
    })
}

/**
 * Revenue cohorts for the shops that first started paying in a range. The range picks the
 * cohorts; each cohort is then followed to today, like the install cohorts. Its starting MRR is
 * what each shop paid when it first started paying; the MRR at the end of a month is what the
 * same shops pay at the last instant of it, read the way getRetention reads the end of a range.
 * Months begin and end at midnight in `timeZone`, the dashboard's time zone.
 */
export async function getRevenueCohorts(db: Queryable, appIds: string[], range: Range, timeZone: string, now: Date = new Date(), periods = 12): Promise<RevenueCohortRow[]> {
  if (appIds.length === 0) return []
  const today = todayIn(timeZone, now)

  // Month boundaries are worked out on the wall clock of the dashboard's time zone, named here, so
  // the session's own time zone cannot move them. Postgres knows the same IANA zone names.
  const rows = await db.execute<{ cohort: string; k: number | null; shops: number; cents: string }>(sql`
    WITH paid AS (
      SELECT app_id, shop, started_at, ended_at, monthly_cents,
             CASE WHEN trial_ends_at IS NULL THEN started_at ELSE greatest(started_at, converted_at) END AS paid_from
      FROM subscriptions
      WHERE app_id IN ${inList(appIds)} AND monthly_cents > 0 AND (trial_ends_at IS NULL OR converted_at IS NOT NULL)
    ), first_paid AS (
      SELECT DISTINCT ON (app_id, shop) app_id, shop, paid_from, monthly_cents AS start_cents
      FROM paid
      WHERE ended_at IS NULL OR paid_from < ended_at
      ORDER BY app_id, shop, paid_from, started_at
    ), members AS (
      SELECT app_id, shop, start_cents, date_trunc('month', paid_from AT TIME ZONE ${timeZone}) AS cohort
      FROM first_paid
      WHERE paid_from >= ${ts(startOfDay(range.from, timeZone))} AND paid_from < ${ts(endOfDay(range.to, timeZone))}
    ), month_ends AS (
      SELECT m.app_id, m.shop, m.cohort, g.k, (m.cohort + make_interval(months => g.k + 1)) AT TIME ZONE ${timeZone} AS at
      FROM members m CROSS JOIN generate_series(0, ${periods - 1}::int) AS g(k)
      WHERE (m.cohort + make_interval(months => g.k + 1)) AT TIME ZONE ${timeZone} <= ${ts(startOfDay(addDays(today, 1), timeZone))}
    ), held AS (
      SELECT e.cohort, e.k, coalesce((
        SELECT CASE WHEN s.trial_ends_at IS NULL OR s.converted_at < e.at THEN s.monthly_cents ELSE 0 END
        FROM subscriptions s
        WHERE s.app_id = e.app_id AND s.shop = e.shop AND s.started_at < e.at AND (s.ended_at IS NULL OR s.ended_at >= e.at)
        ORDER BY s.started_at DESC
        LIMIT 1
      ), 0) AS cents
      FROM month_ends e
    )
    SELECT to_char(cohort, 'YYYY-MM-DD') AS cohort, NULL::int AS k, count(*)::int AS shops, sum(start_cents)::bigint AS cents
    FROM members
    GROUP BY cohort
    UNION ALL
    SELECT to_char(cohort, 'YYYY-MM-DD'), k, (count(*) FILTER (WHERE cents > 0))::int, sum(cents)::bigint
    FROM held
    GROUP BY cohort, k
  `)

  const starts: CohortStart[] = []
  const held: CohortHeld[] = []
  for (const r of rows) {
    if (r.k === null) starts.push({ cohort: r.cohort, shops: r.shops, startMrr: Number(r.cents) })
    else held.push({ cohort: r.cohort, k: r.k, shops: r.shops, mrr: Number(r.cents) })
  }
  return revenueCohortRows(starts, held, today, periods)
}
