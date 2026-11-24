import type { Metadata } from "next"
import { ExportLink } from "@/components/app/export-link"
import { StatGrid } from "@/components/app/kpi-card"
import { PageHeader } from "@/components/app/page-header"
import { BarList } from "@/components/charts/bar-list"
import { ChartCard } from "@/components/charts/chart-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getLifetimeStats } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { INSTALLS_AND_UNINSTALLS, readers, single, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { formatDays, formatInt, formatPercent } from "@/lib/format"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Growth" }

export default async function GrowthPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption, comparison } = d
  const gran = p.granularity
  const life = await getLifetimeStats(getDb(), [appId], p.range)

  // Cumulative counts become the shops that left within each span.
  const buckets = [
    { label: "Within a day", value: life.within1Day },
    { label: "1 to 7 days", value: life.within7Days - life.within1Day },
    { label: "7 to 30 days", value: life.within30Days - life.within7Days },
    { label: "30 days or more", value: life.ended - life.within30Days },
  ]

  return (
    <>
      <PageHeader
        level={2}
        title="Growth"
        description={`Installs and uninstalls, ${formatRange(p.range)}.`}
        actions={<ExportLink params={{ kind: "daily", from: p.range.from, to: p.range.to, apps: appId }} label="Export daily numbers" />}
      />

      <StatGrid ids={["activeInstalls", "installs", "uninstalls", "netInstalls"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["reinstalls", "uninstallRate"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} columns={2} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Installs and uninstalls" description="Uninstalls are drawn below zero." data={totals(rows, p.range, gran, INSTALLS_AND_UNINSTALLS, "int")} kind="diverge" granularity={gran} />
        <ChartCard title="Active installs" description="Shops that have the app installed." data={single(rows, p.range, gran, { key: "active", label: "Active installs", color: slotColor(0), read: readers.activeInstalls }, "int", comparison)} kind="area" granularity={gran} />
        <ChartCard title="Net installs" description="Installs minus uninstalls in each period." data={totals(rows, p.range, gran, [{ key: "net", label: "Net installs", color: slotColor(0), read: readers.netInstalls }], "int")} kind="diverge" granularity={gran} />

        <Card>
          <CardHeader>
            <CardTitle>How long installs last</CardTitle>
            <CardDescription>
              {formatInt(life.ended)} shops uninstalled in this range; {formatInt(life.open)} are still installed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <dl className="grid grid-cols-3 gap-4">
              {[
                ["Median", life.medianDays === null ? "n/a" : formatDays(life.medianDays)],
                ["Average", life.meanDays === null ? "n/a" : formatDays(life.meanDays)],
                ["Gone in a week", life.ended > 0 ? formatPercent(life.within7Days / life.ended, 0) : "n/a"],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 font-heading text-xl font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
            <BarList rows={buckets} empty="No uninstalls in this range." />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
