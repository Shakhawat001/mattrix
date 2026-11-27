import { FLOW_KEYS, STOCK_KEYS, type DayRow } from "./aggregate"
import { LEDGER_TYPES, ledgerMoney } from "./derive"
import { eventLabel } from "./labels"
import type { EventRow, ShopRow } from "./queries"
import type { Range } from "./range"

// What goes in the CSV files. Money is in US dollars with the unit in the column name, so a
// spreadsheet needs no guessing. Text from outside (shop names, merchants' comments) is made
// safe for spreadsheets by lib/csv.ts when the rows are written.

const KEYS = [...FLOW_KEYS, ...STOCK_KEYS] as const

/** `newMrrCents` becomes `new_mrr_usd`. */
const column = (key: string) => key.replace(/Cents$/, "Usd").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

const dollars = (cents: number | null) => (cents === null ? null : cents / 100)

/** One row per app per day: every flow and every stock, oldest first. */
export function dailyRows(rows: DayRow[], labelOf: (appId: string) => string, range: Range): unknown[][] {
  const body = rows
    .filter((r) => r.date >= range.from && r.date <= range.to)
    .sort((a, b) => (a.date === b.date ? labelOf(a.appId).localeCompare(labelOf(b.appId)) : a.date < b.date ? -1 : 1))
    .map((r) => [r.date, labelOf(r.appId), ...KEYS.map((key) => (key.endsWith("Cents") ? dollars(r[key]) : r[key]))])
  return [["date", "app", ...KEYS.map(column)], ...body]
}

export function shopRows(rows: ShopRow[], labelOf: (appId: string) => string): unknown[][] {
  const header = ["app", "shop", "status", "plan", "billing", "in_trial", "mrr_usd", "charged_usd", "installs", "first_installed_at", "last_installed_at", "uninstalled_at", "uninstall_reason"]
  const body = rows.map((s) => [
    labelOf(s.appId),
    s.shop,
    s.installed ? "installed" : "uninstalled",
    s.subscribed || s.inTrial ? s.planHandle : "",
    s.subscribed || s.inTrial ? (s.billingPeriod === "ANNUAL" ? "yearly" : "monthly") : "",
    s.inTrial,
    s.subscribed ? dollars(s.monthlyCents) : 0,
    dollars(s.charged),
    s.installs,
    s.firstInstalledAt,
    s.lastInstalledAt,
    s.uninstalledAt,
    s.reason,
  ])
  return [header, ...body]
}

/**
 * One row per event. For a payout record (a ledger transaction) the gross takes the sign of what it
 * did to the payout and the fee is everything Shopify kept, gross minus net, as the Revenue tab counts
 * it; for an earning event both are as Shopify reported them (its fee is the revenue share).
 */
export function eventRows(rows: EventRow[], labelOf: (appId: string) => string): unknown[][] {
  const header = ["time_utc", "app", "event", "event_type", "shop", "plan", "billing", "amount_usd", "gross_usd", "net_usd", "fee_usd", "uninstall_reason", "comment"]
  const body = rows.map((e) => {
    const ledger = LEDGER_TYPES.has(e.type) ? ledgerMoney(e) : null
    return [
      e.occurredAt,
      labelOf(e.appId),
      eventLabel(e.type),
      e.type,
      e.shop,
      e.planHandle,
      e.billingPeriod,
      dollars(e.amountCents),
      dollars(ledger ? ledger.grossCents : e.grossCents),
      dollars(e.netCents),
      dollars(ledger ? ledger.grossCents - ledger.netCents : e.feeCents),
      e.reason,
      e.reasonDescription,
    ]
  })
  return [header, ...body]
}
