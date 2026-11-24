import type { CohortRow } from "@/lib/analytics/aggregate"
import { bucketTitle } from "@/lib/analytics/view"
import { formatInt } from "@/lib/format"

export const BINS = 7

/** Which of the seven ramp steps a retention share falls in: 0 to 14% is the first, 86% and up the last. */
export const retentionBin = (share: number) => Math.min(BINS - 1, Math.max(0, Math.floor(share * BINS)))

/**
 * Cohort retention as a heatmap. Each row is the shops that installed in one week (or
 * month); each cell is the share still installed at the end of week 0, 1, 2 and on. One
 * hue, light to dark with the share, and the number is printed in the cell so color is
 * never the only way to read it. A cell stays empty until its period has fully passed.
 */
export function CohortTable({ rows, unit }: { rows: CohortRow[]; unit: "week" | "month" }) {
  if (rows.length === 0) return <p className="py-4 text-sm text-muted-foreground">No installs in this range.</p>
  const periods = rows[0].cells.length
  const name = unit === "week" ? "Week" : "Month"

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0.5 text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="px-2 py-1 text-left font-medium tracking-wider uppercase">Installed</th>
              <th className="px-2 py-1 text-right font-medium tracking-wider uppercase">Shops</th>
              {Array.from({ length: periods }, (_, k) => (
                <th key={k} className="min-w-12 px-1 py-1 text-center font-medium tracking-wider uppercase">
                  {name[0]}
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.cohort}>
                <th scope="row" className="px-2 py-1 text-left font-medium whitespace-nowrap">
                  {bucketTitle(row.cohort, unit)}
                </th>
                <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">{formatInt(row.size)}</td>
                {row.cells.map((share, k) =>
                  share === null ? (
                    <td key={k} className="h-8" aria-label="Not yet" />
                  ) : (
                    <td
                      key={k}
                      className="h-8 text-center font-medium tabular-nums"
                      style={{ background: `var(--seq-${retentionBin(share) + 1})`, color: `var(--seq-ink-${retentionBin(share) + 1})` }}
                      title={`${bucketTitle(row.cohort, unit)}: ${Math.round(share * 100)}% of ${row.size} still installed after ${name.toLowerCase()} ${k}`}
                    >
                      {Math.round(share * 100)}%
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
        <span>100% still installed</span>
      </div>
    </div>
  )
}
