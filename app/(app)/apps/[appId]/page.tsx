import type { Metadata } from "next"
import Link from "next/link"
import { AT_RISK_ROWS, AtRiskCard } from "@/components/app/at-risk"
import { ExportLink } from "@/components/app/export-link"
import { StatGrid } from "@/components/app/kpi-card"
import { PageHeader } from "@/components/app/page-header"
import { PlanMix } from "@/components/app/plan-mix"
import { BarList } from "@/components/charts/bar-list"
import { ChartCard } from "@/components/charts/chart-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getAtRisk } from "@/lib/analytics/at-risk"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getPlanMix, getReasons } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { carriedFrom } from "@/lib/analytics/url"
import { INSTALLS_AND_UNINSTALLS, MRR_MOVEMENT, readers, single, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Overview" }

export default async function AppOverviewPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption, comparison, now } = d
  const gran = p.granularity
  const db = getDb()
  const [plans, reasons, atRisk] = await Promise.all([getPlanMix(db, [appId], p.range.to), getReasons(db, [appId], p.range), getAtRisk(db, [appId], now, AT_RISK_ROWS)])
  const carry = carriedFrom(query)

  return (
    <>
      <PageHeader
        level={2}
        title="Overview"
        description={`${formatRange(p.range)}${p.compared ? `, compared with ${formatRange(p.compared)}` : ""}.`}
        actions={<ExportLink params={{ kind: "daily", from: p.range.from, to: p.range.to, apps: appId }} label="Export daily numbers" />}
      />

      <StatGrid ids={["mrr", "activeSubs", "trialSubs", "activeInstalls"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["netNewMrr", "nrr", "subChurnRate", "trialConversion"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />

      <AtRiskCard data={atRisk} carry={carry} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="MRR" description="Monthly recurring revenue at the end of each period." data={single(rows, p.range, gran, { key: "mrr", label: "MRR", color: slotColor(0), read: readers.mrr }, "money", comparison)} kind="area" granularity={gran} />
        <ChartCard title="Active installs" description="Shops that have the app installed." data={single(rows, p.range, gran, { key: "active", label: "Active installs", color: slotColor(0), read: readers.activeInstalls }, "int", comparison)} kind="area" granularity={gran} />
        <ChartCard title="MRR movement" description="New and expansion MRR above zero, contraction and churn below." data={totals(rows, p.range, gran, MRR_MOVEMENT, "money")} kind="diverge" granularity={gran} />
        <ChartCard title="Installs and uninstalls" description="Uninstalls are drawn below zero." data={totals(rows, p.range, gran, INSTALLS_AND_UNINSTALLS, "int")} kind="diverge" granularity={gran} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <PlanMix rows={plans} date={p.range.to} />
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm">Why shops uninstalled</CardTitle>
            <CardDescription className="text-xs">
              The top reasons in this range.{" "}
              <Link href={`/apps/${appId}/churn${carry}`} className="font-medium text-foreground underline underline-offset-4">
                See all and read the comments
              </Link>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={reasons.slice(0, 5).map((r) => ({ label: r.reason, value: r.count }))} empty="No uninstalls in this range." />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
