import type { RevenueCohortRow } from "@/lib/analytics/revenue-cohorts"
import { bucketTitle } from "@/lib/analytics/view"
import { formatInt, formatMoney } from "@/lib/format"
import { BINS, retentionBin } from "./cohort-table"

/**
 * Revenue retention by cohort, drawn like the install cohorts. Each row is the shops that first
 * started paying in one month; each cell is the MRR they still pay at the end of month 0, 1, 2
 * and on, as a share of what they paid when they started. Upgrades count, so a cell can pass
 * 100%, and then it takes the darkest step. The share is printed in the cell so color is never
 * the only way to read it. A cell stays empty until its month has fully passed.
 */
export function RevenueCohortTable({ rows }: { rows: RevenueCohortRow[] }) {
  if (rows.length === 0) return <p className="py-4 text-sm text-muted-foreground">No shop started paying in this range.</p>
  const periods = rows[0].cells.length

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="px-2 py-1 text-left font-medium tracking-wider uppercase">First paid</th>
              <th className="px-2 py-1 text-right font-medium tracking-wider uppercase">Shops</th>
              <th className="px-2 py-1 text-right font-medium tracking-wider whitespace-nowrap uppercase">Starting MRR</th>
              {Array.from({ length: periods }, (_, k) => (
                <th key={k} className="min-w-12 px-1 py-1 text-center font-medium tracking-wider uppercase">
                  M{k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cohort}>
                <th scope="row" className="px-2 py-1 text-left font-medium whitespace-nowrap">
                  {bucketTitle(row.cohort, "month")}
                </th>
                <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{formatInt(row.shops)}</td>
                <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{formatMoney(row.startMrr)}</td>
                {row.cells.map((cell, k) =>
                  cell === null ? (
                    <td key={k} className="h-8" aria-label="Not yet" />
                  ) : cell.share === null ? (
                    <td key={k} className="h-8 text-center text-muted-foreground">
                      n/a
                    </td>
                  ) : (
                    <td
                      key={k}
                      className="h-8 text-center font-medium tabular-nums"
                      style={{ background: `var(--seq-${retentionBin(cell.share) + 1})`, color: `var(--seq-ink-${retentionBin(cell.share) + 1})` }}
                      title={`${bucketTitle(row.cohort, "month")}: ${formatMoney(cell.mrr)} of the ${formatMoney(row.startMrr)} it started with, from ${formatInt(cell.shops)} of ${formatInt(row.shops)} shops still paying at the end of month ${k}`}
                    >
                      {Math.round(cell.share * 100)}%
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
        <span>0%</span>
        <div className="flex h-2 gap-0.5">
          {Array.from({ length: BINS }, (_, i) => (
            <span key={i} className="h-full w-6" style={{ background: `var(--seq-${i + 1})` }} />
          ))}
        </div>
        <span>100% or more of the starting MRR</span>
      </div>
    </div>
  )
}
