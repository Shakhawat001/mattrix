import type { Metadata } from "next"
import { StatGrid } from "@/components/app/kpi-card"
import { PageHeader } from "@/components/app/page-header"
import { ChartCard } from "@/components/charts/chart-card"
import { CohortTable } from "@/components/charts/cohort-table"
import { RevenueCohortTable } from "@/components/charts/revenue-cohort-table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cohortRetention } from "@/lib/analytics/aggregate"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getStays } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { getRevenueCohorts } from "@/lib/analytics/revenue-cohorts"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { SUBS_AND_CANCELS, readers, single, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Retention" }

export default async function RetentionPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption, comparison, now } = d
  const gran = p.granularity

  // Weekly cohorts unless you asked for months: a day's worth of installs is too few to read a rate from.
  const unit = gran === "month" ? "month" : "week"
  const db = getDb()
  const [stays, revenueCohorts] = await Promise.all([getStays(db, p.appIds, p.range), getRevenueCohorts(db, p.appIds, p.range, now)])
  const cohorts = cohortRetention(stays, unit, now, 12)

  return (
    <>
      <PageHeader level={2} title="Retention" description={`Who stayed and who left, ${formatRange(p.range)}.`} />

      <StatGrid ids={["nrr", "grr", "subChurnRate", "revenueChurnRate"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["uninstallRate", "canceledSubs", "newSubs", "trialSubs"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Subscribers gained and lost" description="Cancellations are drawn below zero." data={totals(rows, p.range, gran, SUBS_AND_CANCELS, "int")} kind="diverge" granularity={gran} />
        <ChartCard title="Subscribers" description="Shops on a paid plan at the end of each period." data={single(rows, p.range, gran, { key: "subs", label: "Subscribers", color: slotColor(0), read: readers.activeSubs }, "int", comparison)} kind="area" granularity={gran} />
      </div>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Install cohorts</CardTitle>
          <CardDescription className="text-xs">
            Each row is the shops that installed in that {unit}. Each cell is the share still installed at the end of {unit} 0, 1, 2 and on. Only installs made in the date range are included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CohortTable rows={cohorts} unit={unit} />
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-sm">Revenue cohorts</CardTitle>
          <CardDescription className="text-xs">
            Each row is the shops that first started paying in that month, a trial counting from its conversion. Each cell is the MRR they still pay at the end of month 0, 1, 2 and on, over what they paid when they started. Upgrades count, so a cell can pass 100%. Only shops that first paid in the date range are included, so a longer range shows more cohorts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RevenueCohortTable rows={revenueCohorts} />
        </CardContent>
      </Card>
    </>
  )
}
