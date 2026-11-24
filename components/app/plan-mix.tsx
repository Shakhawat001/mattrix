import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { PlanMixRow } from "@/lib/analytics/queries"
import { formatDate } from "@/lib/analytics/range"
import { formatInt, formatMoney, formatPercent } from "@/lib/format"

/** Who is on which plan at the end of a day, and how much of the MRR each plan is. */
export function PlanMix({ rows, date }: { rows: PlanMixRow[]; date: string }) {
  const mrr = rows.reduce((sum, r) => sum + r.mrrCents, 0)
  const subscribers = rows.reduce((sum, r) => sum + r.subscribers, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Plans</CardTitle>
        <CardDescription>Paying subscribers at the end of {formatDate(date)}. A yearly plan counts at a twelfth of its price.</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <p className="px-(--card-spacing) py-2 text-sm text-muted-foreground">No paying subscribers on this day.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Billed</TableHead>
                <TableHead className="text-right">Subscribers</TableHead>
                <TableHead className="text-right">MRR</TableHead>
                <TableHead className="text-right">Share</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.planHandle}-${r.billingPeriod}`}>
                  <TableCell className="font-medium">{r.planHandle}</TableCell>
                  <TableCell className="text-muted-foreground">{r.billingPeriod}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(r.subscribers)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.mrrCents)}</TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">{mrr > 0 ? formatPercent(r.mrrCents / mrr, 0) : "n/a"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            {rows.length > 1 ? (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={2} className="text-xs font-semibold tracking-wider uppercase">
                    Total
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(subscribers)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(mrr)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
