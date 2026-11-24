import { sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { parseTimestamp, parseTimestampOrNull } from "@/lib/db/timestamps"
import type { SubscriptionRow } from "./derive"
import { toMs, type Range } from "./range"

// The shops behind each MRR movement in a range: who started paying, who moved to a pricier
// or a cheaper plan, and who stopped paying. It reads the subscription periods derive() wrote
// and applies the rules the daily rollup applies to them (buildDaily in derive.ts), so for any
// apps and range the amounts here add up exactly to the rollup's new, expansion, contraction
// and churned MRR, and the new and churned moves to its new and canceled subscribers.
// tests/mrr-movers.test.ts holds the two side by side on generated histories.

const DAY_MS = 86_400_000

export type MrrMoveKind = "new" | "expansion" | "contraction" | "churned"

/** A plan as a shop paid for it. `monthlyCents` is the monthly value: a yearly price divided by twelve. */
export type MrrMovePlan = { planHandle: string | null; billingPeriod: string | null; monthlyCents: number }

export type MrrMove = {
  appId: string
  shop: string
  kind: MrrMoveKind
  /** When it happened: the shop started paying, changed plan, or stopped paying. */
  at: Date
  /**
   * The UTC day the daily rollup counts it on: the day of `at`, except that a move dated after the
   * last rebuild (an event stamped later than the clock that built the rollup) counts on the
   * rollup's last day, as it does there.
   */
  date: string
  /** Cents of MRR, always positive: new and expansion add it, contraction and churned take it away. */
  amountCents: number
  /** The plan before: the one left in a plan change or a move off a free plan, the one that stopped paying in a churn. Null otherwise. */
  before: MrrMovePlan | null
  /** The plan after: the one that started paying, or was moved to. Null when the shop moved to nothing. */
  after: MrrMovePlan | null
  /**
   * New only, how the shop started paying: a subscription with no trial, a trial that converted,
   * a resumed (unfrozen) subscription, or a plan change from a plan that did not pay (a free plan,
   * shown in `before`). Null for the other kinds.
   */
  via: "subscription" | "trial" | "resume" | "plan_change" | null
  /**
   * Churned only, what ended the paying period. "replaced" is a plan change to a plan that does not
   * pay from its start: a free plan, or one with a new free trial (shown in `after`). Null for the other kinds.
   */
  endReason: SubscriptionRow["endReason"]
}

export type MrrTotals = {
  newMrrCents: number
  expansionMrrCents: number
  contractionMrrCents: number
  churnedMrrCents: number
  /** New plus expansion, minus contraction and churned. */
  netNewMrrCents: number
  /** New moves: the rollup's new subscribers. */
  newSubs: number
  /** Churned moves: the rollup's canceled subscribers. */
  canceledSubs: number
}

export type MrrMovers = {
  range: Range
  totals: MrrTotals
  /** Every move in the range, oldest first. */
  moves: MrrMove[]
}

/** A subscription period as derive() writes it. */
export type MoverPeriod = Pick<
  SubscriptionRow,
  "shop" | "startedAt" | "endedAt" | "endReason" | "kind" | "monthlyCents" | "planHandle" | "billingPeriod" | "trialEndsAt" | "convertedAt"
>

/** When a period starts paying: its start, or its trial's conversion. Null when it never pays. The same rule as paidFrom in derive.ts. */
function paidFrom(p: MoverPeriod): number | null {
  if (p.monthlyCents <= 0) return null
  const start = p.startedAt.getTime()
  const from = p.trialEndsAt ? (p.convertedAt ? Math.max(start, p.convertedAt.getTime()) : null) : start
  if (from === null || (p.endedAt && from >= p.endedAt.getTime())) return null
  return from
}

// A shop's periods follow one another: each ends at or before the next begins. Sorting by start,
// then by end with an open period last, puts them back in the order derive() made them. The only
// ties left are periods that began and ended at the same instant; those never pay, so their order
// changes nothing below.
function creationOrder(a: MoverPeriod, b: MoverPeriod): number {
  const byStart = a.startedAt.getTime() - b.startedAt.getTime()
  if (byStart !== 0) return byStart
  return (a.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
}

const planOf = (p: MoverPeriod): MrrMovePlan => ({ planHandle: p.planHandle, billingPeriod: p.billingPeriod, monthlyCents: p.monthlyCents })

/**
 * Every MRR move in one app's subscription periods, in no particular order. `lastDay` is the
 * app's last day in the rollup; a later move is dated on it. Nothing can move before an app's
 * first event, which is its first day in the rollup, so only the end needs this.
 */
export function movesFromPeriods(appId: string, periods: MoverPeriod[], lastDay: string | null): MrrMove[] {
  const byShop = new Map<string, MoverPeriod[]>()
  for (const p of periods) {
    const list = byShop.get(p.shop)
    if (list) list.push(p)
    else byShop.set(p.shop, [p])
  }

  const dayOf = (ms: number) => {
    const day = new Date(ms).toISOString().slice(0, 10)
    return lastDay !== null && day > lastDay ? lastDay : day
  }

  const moves: MrrMove[] = []
  for (const [shop, list] of byShop) {
    list.sort(creationOrder)
    list.forEach((p, i) => {
      const from = paidFrom(p)
      if (from === null) return // free, or a trial that never turned into money

      const base = { appId, shop, at: new Date(from), date: dayOf(from), via: null, endReason: null }
      const prev = list[i - 1]
      // A plan change from a paying plan, paying from its first moment, hands the revenue over:
      // expansion or contraction by the difference. Anything else that starts paying is new.
      if (p.kind === "change" && from === p.startedAt.getTime() && prev && prev.endReason === "replaced" && paidFrom(prev) !== null) {
        if (p.monthlyCents !== prev.monthlyCents) {
          const kind = p.monthlyCents > prev.monthlyCents ? "expansion" : "contraction"
          moves.push({ ...base, kind, amountCents: Math.abs(p.monthlyCents - prev.monthlyCents), before: planOf(prev), after: planOf(p) })
        }
      } else {
        const via = p.trialEndsAt ? "trial" : p.kind === "resume" ? "resume" : p.kind === "change" ? "plan_change" : "subscription"
        moves.push({ ...base, kind: "new", amountCents: p.monthlyCents, before: via === "plan_change" && prev ? planOf(prev) : null, after: planOf(p), via })
      }

      if (!p.endedAt) return
      // The revenue ends, unless a plan change hands it straight to a successor that pays from its start.
      const next = list[i + 1]
      if (p.endReason === "replaced" && next && next.kind === "change" && paidFrom(next) === next.startedAt.getTime()) return
      const end = p.endedAt.getTime()
      moves.push({
        appId,
        shop,
        kind: "churned",
        at: new Date(end),
        date: dayOf(end),
        amountCents: p.monthlyCents,
        before: planOf(p),
        after: p.endReason === "replaced" && next ? planOf(next) : null,
        via: null,
        endReason: p.endReason,
      })
    })
  }
  return moves
}

export function sumMoves(moves: MrrMove[]): MrrTotals {
  const t: MrrTotals = { newMrrCents: 0, expansionMrrCents: 0, contractionMrrCents: 0, churnedMrrCents: 0, netNewMrrCents: 0, newSubs: 0, canceledSubs: 0 }
  for (const m of moves) {
    if (m.kind === "new") {
      t.newMrrCents += m.amountCents
      t.newSubs++
    } else if (m.kind === "expansion") t.expansionMrrCents += m.amountCents
    else if (m.kind === "contraction") t.contractionMrrCents += m.amountCents
    else {
      t.churnedMrrCents += m.amountCents
      t.canceledSubs++
    }
  }
  t.netNewMrrCents = t.newMrrCents + t.expansionMrrCents - t.contractionMrrCents - t.churnedMrrCents
  return t
}

/** `('a', 'b')` for a raw query. An empty list matches nothing. */
function inList(ids: string[]): SQL {
  return ids.length === 0 ? sql`(NULL)` : sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
}

/** A timestamp for a raw query: text with a cast, because the driver cannot encode a Date it has no column for. */
const ts = (ms: number): SQL => sql`${new Date(ms).toISOString()}::timestamptz`

// On the same instant: what ended first, then what started.
const KIND_ORDER: Record<MrrMoveKind, number> = { churned: 0, contraction: 1, expansion: 2, new: 3 }

/**
 * The MRR moves of the apps in a range (UTC days, both ends included), oldest first, with their
 * totals. The totals equal the rollup's flows for the same apps and range.
 */
export async function getMrrMovers(db: Queryable, appIds: string[], range: Range): Promise<MrrMovers> {
  if (appIds.length === 0) return { range, totals: sumMoves([]), moves: [] }
  const start = toMs(range.from)
  const end = toMs(range.to) + DAY_MS

  // Every period of each shop that had a period running in the range, so a move's neighbors (the
  // plan before a change, the plan after a cancel) are always at hand. When the range reaches an
  // app's last rollup day, periods that start after it count too: their moves are dated on that day.
  const rows = await db.execute<{
    app_id: string; shop: string; started_at: string | Date; ended_at: string | Date | null; end_reason: string | null; kind: string
    monthly_cents: string | number; plan_handle: string | null; billing_period: string | null; trial_ends_at: string | Date | null
    converted_at: string | Date | null; last_day: string | null
  }>(sql`
    WITH built AS (
      SELECT app_id, max(date) AS last_day FROM daily_metrics WHERE app_id IN ${inList(appIds)} GROUP BY app_id
    ), touched AS (
      SELECT DISTINCT s.app_id, s.shop
      FROM subscriptions s LEFT JOIN built b USING (app_id)
      WHERE s.app_id IN ${inList(appIds)}
        AND (s.ended_at IS NULL OR s.ended_at >= ${ts(start)})
        AND (s.started_at < ${ts(end)} OR b.last_day IS NULL OR b.last_day <= ${range.to}::date)
    )
    SELECT s.app_id, s.shop, s.started_at, s.ended_at, s.end_reason, s.kind, s.monthly_cents, s.plan_handle, s.billing_period,
           s.trial_ends_at, s.converted_at, b.last_day::text AS last_day
    FROM subscriptions s
    JOIN touched t USING (app_id, shop)
    LEFT JOIN built b USING (app_id)
    WHERE s.app_id IN ${inList(appIds)}
  `)

  const byApp = new Map<string, { lastDay: string | null; periods: MoverPeriod[] }>()
  for (const r of rows) {
    let app = byApp.get(r.app_id)
    if (!app) byApp.set(r.app_id, (app = { lastDay: r.last_day, periods: [] }))
    app.periods.push({
      shop: r.shop,
      startedAt: parseTimestamp(r.started_at),
      endedAt: parseTimestampOrNull(r.ended_at),
      endReason: r.end_reason as SubscriptionRow["endReason"],
      kind: r.kind as SubscriptionRow["kind"],
      monthlyCents: Number(r.monthly_cents),
      planHandle: r.plan_handle,
      billingPeriod: r.billing_period,
      trialEndsAt: parseTimestampOrNull(r.trial_ends_at),
      convertedAt: parseTimestampOrNull(r.converted_at),
    })
  }

  const appOrder = new Map(appIds.map((id, i) => [id, i]))
  const moves = [...byApp]
    .flatMap(([appId, app]) => movesFromPeriods(appId, app.periods, app.lastDay))
    .filter((m) => m.date >= range.from && m.date <= range.to)
    .sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        (appOrder.get(a.appId) ?? 0) - (appOrder.get(b.appId) ?? 0) ||
        (a.shop < b.shop ? -1 : a.shop > b.shop ? 1 : 0) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
    )
  return { range, totals: sumMoves(moves), moves }
}
