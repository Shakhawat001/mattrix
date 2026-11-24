"use client"

import { useState, type ReactNode } from "react"
import { ChartLineIcon, TableIcon } from "lucide-react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Granularity } from "@/lib/analytics/range"
import { bucketTitle, type ChartData } from "@/lib/analytics/view"
import { formatValue } from "@/lib/format"
import { cn } from "@/lib/utils"
import { TimeChart, type ChartKind } from "./time-chart"

type Props = {
  title: string
  description?: ReactNode
  data: ChartData
  kind: ChartKind
  granularity: Granularity
  height?: number
  className?: string
}

const BUCKET_NAME: Record<Granularity, string> = { day: "Day", week: "Week", month: "Month" }

/**
 * A chart with its title, a legend when there is more than one series, and a table view of
 * the same numbers. The table is the accessible twin: every value in the tooltip is also here.
 */
export function ChartCard({ title, description, data, kind, granularity, height = 256, className }: Props) {
  const [view, setView] = useState<"chart" | "table">("chart")
  const empty = data.points.length === 0 || data.series.every((s) => data.points.every((p) => Number(p[s.key]) === 0))
  const legend = data.series.length > 1 || Boolean(data.compare)
  const lineKeys = kind === "line" || kind === "area"

  return (
    <Card size="sm" className={className}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
        {empty ? null : (
          <CardAction>
            <ToggleGroup variant="outline" size="sm" spacing={0} value={[view]} onValueChange={(v) => v[0] && setView(v[0] as "chart" | "table")} aria-label="View">
              <ToggleGroupItem value="chart" aria-label="Chart view" className="px-2.5">
                <ChartLineIcon aria-hidden />
              </ToggleGroupItem>
              <ToggleGroupItem value="table" aria-label="Table view" className="px-2.5">
                <TableIcon aria-hidden />
              </ToggleGroupItem>
            </ToggleGroup>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {empty ? (
          <p className="flex items-center justify-center text-sm text-muted-foreground" style={{ height: height / 2 }}>
            Nothing to show for this range.
          </p>
        ) : (
          <>
            {legend ? (
              <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
                {data.series.map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className={cn("shrink-0", lineKeys ? "h-0.5 w-3" : "size-2.5")} style={{ background: s.color }} aria-hidden />
                    {s.label}
                  </li>
                ))}
                {data.compare ? (
                  <li className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="h-0.5 w-3 shrink-0 bg-muted-foreground" aria-hidden />
                    {data.compare.label}
                  </li>
                ) : null}
              </ul>
            ) : null}

            {view === "chart" ? (
              <div role="img" aria-label={`${title}. Switch to the table view for exact values.`}>
                <TimeChart data={data} kind={kind} granularity={granularity} height={height} />
              </div>
            ) : (
              <div className="overflow-auto" style={{ maxHeight: height + 32 }}>
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>{BUCKET_NAME[granularity]}</TableHead>
                      {data.series.map((s) => (
                        <TableHead key={s.key} className="text-right">
                          {s.label}
                        </TableHead>
                      ))}
                      {data.compare ? <TableHead className="text-right">{data.compare.label}</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.points.map((p, i) => (
                      <TableRow key={p.bucket}>
                        <TableCell>{bucketTitle(p.bucket, granularity)}</TableCell>
                        {data.series.map((s) => (
                          <TableCell key={s.key} className="text-right tabular-nums">
                            {formatValue(Number(p[s.key]), data.format)}
                          </TableCell>
                        ))}
                        {data.compare ? <TableCell className="text-right text-muted-foreground tabular-nums">{formatValue(data.compare.values[i], data.format)}</TableCell> : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
