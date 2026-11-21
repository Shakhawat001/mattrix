import { formatInt, formatPercent } from "@/lib/format"

export type BarRow = { label: string; value: number; note?: string }

/**
 * Ranked categories as thin horizontal bars. One series, so every bar wears the same hue
 * (color is not spent re-encoding what length already shows) and there is no legend: the
 * card's title says what is counted. Length is relative to the longest bar; the text gives
 * the count and the share of the total.
 */
export function BarList({ rows, color = "var(--series-1)", empty = "Nothing to show for this range." }: { rows: BarRow[]; color?: string; empty?: string }) {
  const total = rows.reduce((sum, r) => sum + r.value, 0)
  const max = Math.max(1, ...rows.map((r) => r.value))
  if (rows.length === 0 || total === 0) return <p className="py-4 text-sm text-muted-foreground">{empty}</p>

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.label} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="min-w-0 truncate" title={row.label}>
              {row.label}
            </span>
            <span className="shrink-0 tabular-nums">
              <span className="font-semibold">{formatInt(row.value)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{formatPercent(row.value / total, 0)}</span>
            </span>
          </div>
          <div className="h-1.5 w-full bg-muted" aria-hidden>
            <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(2, (row.value / max) * 100)}%`, background: color }} />
          </div>
          {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
        </li>
      ))}
    </ul>
  )
}

/** One bar split into parts, for part-to-whole such as what became of the trials. */
export function OutcomeBar({ parts }: { parts: { label: string; value: number; color: string }[] }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  if (total === 0) return <p className="py-4 text-sm text-muted-foreground">Nothing to show for this range.</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-6 w-full gap-0.5" role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => (
            <div key={p.label} className="h-full first:rounded-l-[4px] last:rounded-r-[4px]" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
          ))}
      </div>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span className="size-2.5 shrink-0" style={{ background: p.color }} aria-hidden />
              {p.label}
            </span>
            <span className="tabular-nums">
              <span className="font-semibold">{formatInt(p.value)}</span>
              <span className="ml-2 text-xs text-muted-foreground">{formatPercent(p.value / total, 0)}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
