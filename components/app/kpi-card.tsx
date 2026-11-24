import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { Kpis, SeriesPoint } from "@/lib/analytics/aggregate"
import { METRICS, metricValue, type MetricId } from "@/lib/analytics/metrics-registry"
import { sparkValues } from "@/lib/analytics/view"
import { describeChange, formatValue, type Change } from "@/lib/format"
import { cn } from "@/lib/utils"
import { MetricHint } from "./metric-hint"
import { Sparkline } from "./sparkline"

const TONE: Record<Change["tone"], string> = {
  good: "text-(color:--delta-good)",
  bad: "text-(color:--delta-bad)",
  flat: "text-muted-foreground",
  none: "text-muted-foreground",
}

/** A change against the comparison range. The arrow and the words carry it too, so color is never the only signal. */
function Delta({ change, caption, previous }: { change: Change; caption: string; previous: string }) {
  const Icon = change.text.startsWith("+") ? ArrowUpIcon : change.text.startsWith("-") ? ArrowDownIcon : MinusIcon
  const direction = change.text.startsWith("+") ? "Up" : change.text.startsWith("-") ? "Down" : null
  return (
    <p className={cn("flex items-center gap-1 text-xs", TONE[change.tone])} title={`Before: ${previous}`}>
      {change.tone === "none" ? null : <Icon strokeWidth={2.5} className="size-3" aria-hidden />}
      {direction ? <span className="sr-only">{direction} </span> : null}
      <span className="font-medium tabular-nums">{change.text}</span>
      <span className="text-muted-foreground">{caption}</span>
    </p>
  )
}

export function KpiCard({
  id,
  kpis,
  compared,
  caption,
  points,
}: {
  id: MetricId
  kpis: Kpis
  compared: Kpis | null
  caption: string
  points: SeriesPoint[]
}) {
  const def = METRICS[id]
  const value = metricValue(kpis, id)
  const before = compared ? metricValue(compared, id) : null
  const spark = sparkValues(points, id)

  return (
    <Card size="sm" className="gap-2">
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{def.label}</span>
          <MetricHint text={def.description} label={`What ${def.label} means`} />
        </div>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-heading text-3xl leading-tight font-semibold">{formatValue(value, def.format, { compact: true })}</p>
            {compared ? <Delta change={describeChange(value, before, def)} caption={caption} previous={formatValue(before, def.format)} /> : <p className="h-4" />}
          </div>
          <Sparkline values={spark} />
        </div>
      </CardContent>
    </Card>
  )
}

/** A row of KPI tiles. */
export function StatGrid({
  ids,
  kpis,
  compared,
  caption,
  points,
  columns = "xl:grid-cols-4",
}: {
  ids: MetricId[]
  kpis: Kpis
  compared: Kpis | null
  caption: string
  points: SeriesPoint[]
  columns?: string
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", columns)}>
      {ids.map((id) => (
        <KpiCard key={id} id={id} kpis={kpis} compared={compared} caption={caption} points={points} />
      ))}
    </div>
  )
}
