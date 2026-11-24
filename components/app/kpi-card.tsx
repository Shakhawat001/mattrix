import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import type { Kpis, SeriesPoint } from "@/lib/analytics/aggregate"
import { METRICS, metricValue, type MetricDef, type MetricId } from "@/lib/analytics/metrics-registry"
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
function Delta({ change }: { change: Change }) {
  const Icon = change.text.startsWith("+") ? TrendingUpIcon : change.text.startsWith("-") ? TrendingDownIcon : MinusIcon
  const direction = change.text.startsWith("+") ? "Up" : change.text.startsWith("-") ? "Down" : null
  // Transparent, not the outline badge's tint: the good and bad colors were checked against the card itself.
  return (
    <Badge variant="outline" className={cn("bg-transparent", TONE[change.tone])}>
      {change.tone === "none" ? null : <Icon strokeWidth={2.5} aria-hidden />}
      {direction ? <span className="sr-only">{direction} </span> : null}
      <span className="tabular-nums">{change.text}</span>
    </Badge>
  )
}

/** The footer's plain sentence: which way the number went, and from what. */
function Trend({ value, before, def }: { value: number | null; before: number | null; def: MetricDef }) {
  const was = formatValue(before, def.format)
  const diff = value === null || before === null ? null : value - before
  const text = before === null ? "Nothing to compare with" : diff === null ? `Was ${was}` : Math.abs(diff) < 1e-9 ? `Unchanged at ${was}` : `${diff > 0 ? "Up" : "Down"} from ${was}`
  const Icon = diff === null || Math.abs(diff) < 1e-9 ? null : diff > 0 ? TrendingUpIcon : TrendingDownIcon
  return (
    <div className="flex min-w-0 items-center gap-2 font-medium">
      <span className="truncate tabular-nums">{text}</span>
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
    </div>
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
  // The (i) stays with the label's last word when a long label wraps.
  const words = def.label.split(" ")
  const lastWord = words.pop()

  return (
    <Card className="@container/card">
      {/* The header fills the card and the number sits at its foot, so numbers line up across a row even when a label wraps. */}
      <CardHeader className="flex-1 has-data-[slot=card-description]:grid-rows-[auto_1fr]">
        <CardDescription>
          {words.length > 0 ? `${words.join(" ")} ` : null}
          <span className="whitespace-nowrap">
            {lastWord}{" "}
            <span className="inline-flex align-[-2px]">
              <MetricHint text={def.description} label={`What ${def.label} means`} />
            </span>
          </span>
        </CardDescription>
        <CardTitle className="min-w-0 self-end truncate text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">{formatValue(value, def.format, { compact: true })}</CardTitle>
        <CardAction className="flex flex-col items-end justify-end gap-1 self-stretch">
          {compared ? (
            <div className="mb-auto">
              <Delta change={describeChange(value, before, def)} />
            </div>
          ) : null}
          <Sparkline values={spark} width={80} height={32} />
        </CardAction>
      </CardHeader>
      {compared ? (
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <Trend value={value} before={before} def={def} />
          <div className="text-muted-foreground">{caption}</div>
        </CardFooter>
      ) : null}
    </Card>
  )
}

const COLUMNS = { 2: "@5xl/main:grid-cols-2", 3: "@5xl/main:grid-cols-3", 4: "@5xl/main:grid-cols-4" }

/** A row of KPI cards. */
export function StatGrid({
  ids,
  kpis,
  compared,
  caption,
  points,
  columns = 4,
}: {
  ids: MetricId[]
  kpis: Kpis
  compared: Kpis | null
  caption: string
  points: SeriesPoint[]
  columns?: keyof typeof COLUMNS
}) {
  // A lighter tint than the block's /5, so the muted footer text keeps 4.5:1 against it.
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/3 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs @xl/main:grid-cols-2 dark:*:data-[slot=card]:bg-card",
        COLUMNS[columns],
      )}
    >
      {ids.map((id) => (
        <KpiCard key={id} id={id} kpis={kpis} compared={compared} caption={caption} points={points} />
      ))}
    </div>
  )
}
