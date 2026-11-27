import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableRow } from "@/components/ui/table"
import type { EarningsBreakdown as Breakdown, EarningsLine } from "@/lib/analytics/earnings"
import { formatDateTime, formatMoney } from "@/lib/format"

/**
 * The first four are the lines of the Earnings card on an app's page in the Partner Dashboard, in its
 * order. Refunds and adjustments have no line there; they get their own here.
 */
const LINES: { key: EarningsLine; label: string }[] = [
  { key: "oneTime", label: "One-time charges" },
  { key: "recurring", label: "Recurring charges" },
  { key: "usage", label: "Usage-based charges" },
  { key: "credits", label: "Application credits" },
  { key: "adjustments", label: "Refunds and adjustments" },
]

/** Payout records read longer ago than this mean their sync is failing: the later days are then from the earning events. */
const STALE_MS = 2 * 86_400_000

type Props = {
  breakdown: Breakdown
  range: string
  timeZone: string
  now: Date
  /** Demo data has no payout records, by design. */
  isDemo: boolean
  /** Why the payout records could not be read on the last sync, if they could not. */
  recordsError: string | null
}

/** Why the lines come from the earning events, when they do. */
function fallbackReason({ isDemo, recordsError }: Props): string {
  if (isDemo) return "Demo data has no payout records."
  if (recordsError) return "Shopify's payout records could not be read; Settings says why."
  return "No payout record of this app has been read yet."
}

/**
 * What reached you over the range, line by line, the way the Earnings card on an app's page in
 * Shopify's Partner Dashboard lists it, so the two can be checked against each other.
 */
export function EarningsBreakdown(props: Props) {
  const { breakdown, range, timeZone, now } = props
  const until = breakdown.ledgerUntil
  const stale = until !== null && now.getTime() - until.getTime() > STALE_MS
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earnings, as Shopify lists them</CardTitle>
        <CardDescription>
          {until
            ? `What reached your payouts, ${range}, from Shopify's payout records: after its revenue share, the 2.9% processing fee and any regulatory operating fee. Compare it with the Earnings card on the app's page in the Partner Dashboard. That card may not cover the same days, and it counts your excluded shops.`
            : `From Shopify's earning events, ${range}: after its revenue share but not the 2.9% processing fee or a regulatory operating fee, so they can come out higher than the Earnings card in the Partner Dashboard. ${fallbackReason(props)}`}
          {stale && until ? ` Shopify's payout records are read only up to ${formatDateTime(until, timeZone)}; what came after comes from the earning events, before the processing fee.` : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableBody>
              {LINES.map(({ key, label }) => (
                <TableRow key={key}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(breakdown.lines[key])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-medium">{until ? "Earnings" : "Total"}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatMoney(breakdown.total)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}
