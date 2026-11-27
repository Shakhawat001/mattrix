import { and, eq, gt, gte, inArray, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { apps, events } from "@/lib/db/schema"
import { EARNING_EVENT_TYPES, TRANSACTION_TYPES } from "@/lib/partner/query"
import { endOfDay, startOfDay } from "@/lib/time-zone"
import type { Range } from "./range"

// Which stored rows carry an app's earnings, for every reader outside the rollup: the Revenue tab's
// breakdown, a shop's totals and its timeline. They follow the cutoff the app's last rebuild used
// (apps.ledger_until, derive()'s ledgerUntil), so they always agree with the rollup: Shopify's payout
// ledger up to the cutoff, the earning events after it, or the earning events alone without one.

/** Leaves out the excluded shops, as rebuildApp() does. A row with no shop is kept. */
const notExcluded: SQL = sql`NOT EXISTS (SELECT 1 FROM excluded_shops x WHERE x.shop = lower(${events.shop}))`

const LEDGER: string[] = [...TRANSACTION_TYPES]
const EARNING: string[] = [...EARNING_EVENT_TYPES]

/** Up to when the app's earnings come from the payout ledger, as its last rebuild decided. Null: from the earning events alone. */
export async function getLedgerCutoff(db: Queryable, appId: string): Promise<Date | null> {
  const [row] = await db.select({ until: apps.ledgerUntil }).from(apps).where(eq(apps.id, appId))
  return row?.until ?? null
}

/** The rows that count toward earnings, as derive()'s countsAsEarning() picks them, in SQL. */
export function earningRows(cutoff: Date | null): SQL {
  if (!cutoff) return inArray(events.type, EARNING)
  return or(and(inArray(events.type, LEDGER), lte(events.occurredAt, cutoff)), and(inArray(events.type, EARNING), gt(events.occurredAt, cutoff))) as SQL
}

/** Every row but the earnings rows that do not count: what a shop's timeline lists. */
export function shownRows(cutoff: Date | null): SQL {
  return or(notInArray(events.type, [...LEDGER, ...EARNING]), earningRows(cutoff)) as SQL
}

export type EarningsLine = "recurring" | "oneTime" | "usage" | "credits" | "adjustments"

/** The Partner Dashboard's line for each ledger transaction and each earning event. */
const LINE_OF: Record<string, EarningsLine> = {
  APP_SUBSCRIPTION_SALE: "recurring",
  APP_ONE_TIME_SALE: "oneTime",
  APP_USAGE_SALE: "usage",
  APP_SALE_CREDIT: "credits",
  APP_SALE_ADJUSTMENT: "adjustments",
  EARNING_CHARGE_RECURRING: "recurring",
  EARNING_CHARGE_ONE_TIME: "oneTime",
  EARNING_CHARGE_USAGE: "usage",
  EARNING_CREDIT: "credits",
  EARNING_REFUND: "adjustments",
  EARNING_ADJUSTMENT: "adjustments",
}

export type EarningsBreakdown = {
  /** Up to when the lines come from the payout ledger (after every Shopify fee); the earning events (after the revenue share only) after it. Null: the earning events alone. */
  ledgerUntil: Date | null
  /** Net amounts in cents, each with its sign: credits and refunds are negative. */
  lines: Record<EarningsLine, number>
  /** The lines added up: the range's net earnings. */
  total: number
}

/** The net earnings of one app over a range, split into the Partner Dashboard's lines. Days are in `timeZone`. */
export async function getEarningsBreakdown(db: Queryable, appId: string, range: Range, timeZone: string): Promise<EarningsBreakdown> {
  const ledgerUntil = await getLedgerCutoff(db, appId)
  // Sums come back as text (bigint).
  const rows = await db
    .select({ type: events.type, net: sql<string>`coalesce(sum(${events.netCents}), 0)::bigint` })
    .from(events)
    .where(
      and(
        eq(events.appId, appId),
        earningRows(ledgerUntil),
        gte(events.occurredAt, startOfDay(range.from, timeZone)),
        lt(events.occurredAt, endOfDay(range.to, timeZone)),
        notExcluded,
      ),
    )
    .groupBy(events.type)

  const lines: Record<EarningsLine, number> = { recurring: 0, oneTime: 0, usage: 0, credits: 0, adjustments: 0 }
  for (const row of rows) {
    const line = LINE_OF[row.type]
    if (line) lines[line] += Number(row.net)
  }
  return { ledgerUntil, lines, total: lines.recurring + lines.oneTime + lines.usage + lines.credits + lines.adjustments }
}
