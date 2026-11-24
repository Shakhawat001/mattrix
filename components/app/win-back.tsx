import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { COHORT_METRICS, type CohortMetricId } from "@/lib/analytics/metrics-registry"
import { formatDate } from "@/lib/analytics/range"
import type { WinBack } from "@/lib/analytics/win-back"
import { formatDays, formatInt, formatValue } from "@/lib/format"
import { MetricHint } from "./metric-hint"

const day = (d: Date) => formatDate(d.toISOString().slice(0, 10))

/** The shops that uninstalled in the range and came back: how many, what share, how soon, and the latest of them. */
export function WinBackCard({ data }: { data: WinBack }) {
  const stats: { id: CohortMetricId; value: number | null }[] = [
    { id: "wonBack", value: data.returned },
    { id: "winBackRate", value: data.rate },
    { id: "daysToReturn", value: data.medianDays },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Win-back</CardTitle>
        <CardDescription>
          {data.left === 0
            ? "No shop uninstalled in this range."
            : `${formatInt(data.left)} ${data.left === 1 ? "shop" : "shops"} uninstalled in this range. Their returns are counted up to today.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <dl className="grid grid-cols-3 gap-4">
          {stats.map(({ id, value }) => {
            const def = COHORT_METRICS[id]
            return (
              <div key={id}>
                <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {def.label}
                  <MetricHint text={def.description} label={`What ${def.label} means`} />
                </dt>
                <dd className="mt-1 font-heading text-xl font-semibold">{formatValue(value, def.format)}</dd>
              </div>
            )
          })}
        </dl>

        {data.left === 0 ? null : data.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">None of them has come back yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {data.returned > data.recent.length ? `The latest ${formatInt(data.recent.length)} of ${formatInt(data.returned)} returns` : "Returns, latest first"}
            </p>
            <ul className="flex flex-col divide-y">
              {data.recent.map((r) => (
                <li key={`${r.appId}:${r.shop}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate">{r.shop}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Left {day(r.leftAt)}, back {day(r.backAt)}, after {formatDays(r.days)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
