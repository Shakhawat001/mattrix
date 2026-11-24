import type { Metadata } from "next"
import Link from "next/link"
import { TrendingUpIcon } from "lucide-react"
import { AT_RISK_ROWS, AtRiskCard } from "@/components/app/at-risk"
import { EmptyState } from "@/components/app/empty-state"
import { ExportLink } from "@/components/app/export-link"
import { StatGrid } from "@/components/app/kpi-card"
import { MatrixTable } from "@/components/app/matrix-table"
import { PageHeader } from "@/components/app/page-header"
import { ChartCard } from "@/components/charts/chart-card"
import { getAtRisk } from "@/lib/analytics/at-risk"
import type { MetricId } from "@/lib/analytics/metrics-registry"
import { buildMatrix } from "@/lib/analytics/matrix"
import type { SearchParams } from "@/lib/analytics/page-params"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { swatchColor } from "@/lib/analytics/series"
import { carriedFrom } from "@/lib/analytics/url"
import { INSTALLS_AND_UNINSTALLS, MRR_MOVEMENT, SUBS_AND_CANCELS, byApp, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "All apps" }

const MATRIX_COLUMNS: MetricId[] = ["activeInstalls", "netInstalls", "activeSubs", "mrr", "netNewMrr", "nrr", "subChurnRate", "trialConversion", "charged"]

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireSession()
  const query = await searchParams
  const d = await loadDashboard(query)

  if (d.visible.length === 0) {
    return (
      <>
        <PageHeader title="All apps" />
        <EmptyState icon={<TrendingUpIcon />} title={d.all.length > 0 ? "Every app is hidden" : "No apps yet"}>
          {d.all.length > 0 ? (
            <p>
              Show an app again in{" "}
              <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">
                Settings
              </Link>
              .
            </p>
          ) : (
            <p>
              Add your Shopify Partner API token in{" "}
              <Link href="/settings" className="font-medium text-foreground underline underline-offset-4">
                Settings
              </Link>{" "}
              and the first sync will pull your apps and their history. It can take a few minutes. To look around first, run <code className="bg-muted px-1.5 py-0.5 text-foreground">pnpm cli seed-demo</code> to load invented demo data.
            </p>
          )}
        </EmptyState>
      </>
    )
  }

  const { params, rows, points, kpis, comparedKpis, caption, series, shown, colors, retention, comparedRetention, now } = d
  const gran = params.granularity
  const carry = carriedFrom(query)
  const atRisk = await getAtRisk(getDb(), params.appIds, now, AT_RISK_ROWS)

  const matrix = buildMatrix(
    shown.map((a) => ({ id: a.id, label: a.label, color: swatchColor(colors, a.id), href: `/apps/${a.id}${carry}` })),
    rows,
    params.range,
    params.compared,
    gran,
    MATRIX_COLUMNS,
    retention,
    comparedRetention,
  )

  return (
    <>
      <PageHeader
        title="All apps"
        description={`${shown.length} ${shown.length === 1 ? "app" : "apps"}, ${formatRange(params.range)}${params.compared ? `, compared with ${formatRange(params.compared)}` : ""}.`}
        actions={<ExportLink params={{ kind: "daily", from: params.range.from, to: params.range.to, apps: params.appIds.join(",") }} label="Export daily numbers" />}
      />

      <StatGrid ids={["mrr", "activeInstalls", "activeSubs", "netNewMrr"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["nrr", "subChurnRate", "trialConversion", "charged"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />

      <AtRiskCard data={atRisk} apps={shown} carry={carry} />

      <MatrixTable
        title="Apps side by side"
        description="Click a heading to sort. The small figure under each number is the change against the comparison range."
        rows={matrix.rows}
        total={matrix.total}
        columns={MATRIX_COLUMNS}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="MRR by app" description="Monthly recurring revenue at the end of each period." data={byApp(rows, params.range, gran, "mrrCents", series, "money")} kind="line" granularity={gran} />
        <ChartCard title="Active installs by app" description="Shops that have each app installed." data={byApp(rows, params.range, gran, "activeInstalls", series, "int")} kind="line" granularity={gran} />
        <ChartCard title="MRR movement" description="New and expansion MRR above zero, contraction and churn below." data={totals(rows, params.range, gran, MRR_MOVEMENT, "money")} kind="diverge" granularity={gran} />
        <ChartCard title="Installs and uninstalls" description="Uninstalls are drawn below zero." data={totals(rows, params.range, gran, INSTALLS_AND_UNINSTALLS, "int")} kind="diverge" granularity={gran} />
        <ChartCard title="Subscribers gained and lost" description="Cancellations are drawn below zero." data={totals(rows, params.range, gran, SUBS_AND_CANCELS, "int")} kind="diverge" granularity={gran} />
        <ChartCard title="Charged by app" description="What merchants were charged, before Shopify's fee." data={byApp(rows, params.range, gran, "chargedCents", series, "money")} kind="stack" granularity={gran} />
      </div>
    </>
  )
}
