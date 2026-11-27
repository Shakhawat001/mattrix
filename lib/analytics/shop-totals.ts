import { and, eq, sql } from "drizzle-orm"
import type { Queryable } from "@/lib/db/client"
import { events } from "@/lib/db/schema"
import { earningRows, getLedgerCutoff } from "./earnings"

// What one shop has paid in one app, summed over all of its events. The shop timeline keeps only
// the latest events, so a total added up from its list could come out short.

export type ShopTotals = {
  /** Recurring, one-time and usage charges before Shopify's fee: the shops page's "Charged in all". */
  chargedCents: number
  /** Charges refunded to the merchant, as a positive amount. */
  refundedCents: number
  /**
   * What reached you, refunds, credits and adjustments included: from Shopify's payout ledger, after
   * every fee, up to the app's ledger cutoff, and from the earning events (after the revenue share
   * only) after it, the rule derive() uses. Null when the shop has none of those rows (a token that
   * cannot read them stores none).
   */
  netEarnedCents: number | null
}

/** One shop's totals in one app, the shop matched like getShopTimeline matches it. Zero for a shop with no events. */
export async function getShopTotals(db: Queryable, appId: string, shop: string): Promise<ShopTotals> {
  const domain = shop.trim().toLowerCase()
  const cutoff = await getLedgerCutoff(db, appId)
  // Sums come back as text (bigint), and the net is null when no earnings row matched.
  const [row] = await db
    .select({
      charged: sql<string>`coalesce(sum(${events.amountCents}) FILTER (WHERE ${events.type} IN ('CHARGE_RECURRING', 'CHARGE_ONE_TIME', 'CHARGE_USAGE')), 0)::bigint`,
      refunded: sql<string>`coalesce(sum(abs(coalesce(${events.grossCents}, ${events.netCents}, 0))) FILTER (WHERE ${events.type} = 'EARNING_REFUND'), 0)::bigint`,
      net: sql<string | null>`(sum(coalesce(${events.netCents}, 0)) FILTER (WHERE ${earningRows(cutoff)}))::bigint`,
    })
    .from(events)
    .where(and(eq(events.appId, appId), eq(events.shop, domain)))

  return {
    chargedCents: Number(row?.charged ?? 0),
    refundedCents: Number(row?.refunded ?? 0),
    netEarnedCents: row?.net === null || row?.net === undefined ? null : Number(row.net),
  }
}
