"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { METRICS, shortLabel, type MetricId } from "@/lib/analytics/metrics-registry"
import { describeChange, formatValue } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Sparkline } from "./sparkline"

export type MatrixRow = {
  id: string
  label: string
  color: string
  href: string
  values: Partial<Record<MetricId, number | null>>
  /** The same numbers over the comparison range, when one is chosen. */
  before: Partial<Record<MetricId, number | null>> | null
  /** MRR over time, for the trend column. */
  spark: number[]
}

const TONE = { good: "text-(color:--delta-good)", bad: "text-(color:--delta-bad)", flat: "text-muted-foreground", none: "text-muted-foreground" }

/**
 * Every app against every metric, with the change against the comparison range under each
 * number. Click a heading to sort. The total row is for the apps shown, not a sum of the
 * rows' rates, so a ratio in it is the ratio of the whole.
 */
export function MatrixTable({ rows, total, columns, title, description }: { rows: MatrixRow[]; total: MatrixRow; columns: MetricId[]; title: string; description?: string }) {
  const [sort, setSort] = useState<{ by: MetricId | "app"; desc: boolean }>({ by: "mrr", desc: true })

  const sorted = useMemo(() => {
    const direction = sort.desc ? -1 : 1
    return [...rows].sort((a, b) => {
      if (sort.by === "app") return a.label.localeCompare(b.label) * direction
      const x = a.values[sort.by] ?? Number.NEGATIVE_INFINITY
      const y = b.values[sort.by] ?? Number.NEGATIVE_INFINITY
      return (x === y ? a.label.localeCompare(b.label) : x - y) * direction
    })
  }, [rows, sort])

  function sortBy(by: MetricId | "app") {
    setSort((current) => (current.by === by ? { by, desc: !current.desc } : { by, desc: by !== "app" }))
  }

  // The heading sorts on click. Hovering or focusing it shows the full name and what the number means.
  const header = (by: MetricId | "app", label: string, align: "left" | "right", hint?: string) => {
    const button = (
      <button type="button" onClick={() => sortBy(by)} className={cn("inline-flex items-center gap-1 text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground", align === "right" && "flex-row-reverse")} />
    )
    const arrow = sort.by === by ? sort.desc ? <ChevronDownIcon strokeWidth={2.5} className="size-3" aria-hidden /> : <ChevronUpIcon strokeWidth={2.5} className="size-3" aria-hidden /> : <span className="size-3" aria-hidden />
    return (
      <th
        key={by}
        scope="col"
        aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : "none"}
        className={cn("px-3 py-3 font-medium", align === "right" ? "text-right" : "sticky left-0 z-10 bg-card text-left")}
      >
        {hint ? (
          <Tooltip>
            <TooltipTrigger render={button}>
              {label}
              {arrow}
            </TooltipTrigger>
            <TooltipContent className="max-w-64 leading-relaxed">{hint}</TooltipContent>
          </Tooltip>
        ) : (
          <button type="button" onClick={() => sortBy(by)} className="inline-flex items-center gap-1 text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:text-foreground">
            {label}
            {arrow}
          </button>
        )}
      </th>
    )
  }

  const cell = (row: MatrixRow, id: MetricId) => {
    const def = METRICS[id]
    const value = row.values[id] ?? null
    const change = row.before ? describeChange(value, row.before[id] ?? null, def) : null
    return (
      <td key={id} className="px-2.5 py-2.5 text-right align-top whitespace-nowrap tabular-nums">
        <div className="font-medium">{formatValue(value, def.format, { compact: true })}</div>
        {change && change.tone !== "none" ? <div className={cn("text-xs", TONE[change.tone])}>{change.text}</div> : null}
      </td>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              {header("app", "App", "left")}
              {columns.map((id) => header(id, shortLabel(id), "right", `${METRICS[id].label}. ${METRICS[id].description}`))}
              <th scope="col" className="px-3 py-3 text-right text-xs font-medium tracking-wider whitespace-nowrap text-muted-foreground uppercase">
                MRR trend
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.id} className="border-b transition-colors hover:bg-muted/50">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2.5 text-left align-top font-medium">
                  <Link href={row.href} className="flex items-center gap-2.5 whitespace-nowrap hover:underline">
                    <span className="size-2.5 shrink-0 rounded-full" style={{ background: row.color }} aria-hidden />
                    {row.label}
                  </Link>
                </th>
                {columns.map((id) => cell(row, id))}
                <td className="px-3 py-1.5 text-right align-middle">
                  <div className="flex justify-end">
                    <Sparkline values={row.spark} color={row.color} width={80} height={28} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 ? (
            <tfoot>
              <tr className="bg-muted">
                <th scope="row" className="sticky left-0 z-10 bg-muted px-3 py-2.5 text-left align-top text-xs font-semibold tracking-wider uppercase">
                  {total.label}
                </th>
                {columns.map((id) => cell(total, id))}
                <td className="px-3 py-1.5 text-right align-middle">
                  <div className="flex justify-end">
                    <Sparkline values={total.spark} width={80} height={28} />
                  </div>
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </CardContent>
    </Card>
  )
}
