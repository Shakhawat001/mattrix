import type { Metadata } from "next"
import { ExportLink } from "@/components/app/export-link"
import { StatGrid } from "@/components/app/kpi-card"
import { Note, PageHeader } from "@/components/app/page-header"
import { PlanMix } from "@/components/app/plan-mix"
import { ChartCard } from "@/components/charts/chart-card"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getConnections, getPlanMix } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { EARNINGS_SPLIT, MRR_MOVEMENT, readers, single, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Revenue" }

export default async function RevenuePage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption, comparison, scope } = d
  const gran = p.granularity
  const db = getDb()
  const [plans, connections] = await Promise.all([getPlanMix(db, [appId], p.range.to), getConnections(db)])
  const earningsError = connections.find((c) => c.id === scope[0]?.connectionId)?.earningsError ?? null

  return (
    <>
      <PageHeader
        level={2}
        title="Revenue"
        description={`Recurring revenue and what reached you, ${formatRange(p.range)}.`}
        actions={<ExportLink params={{ kind: "daily", from: p.range.from, to: p.range.to, apps: appId }} label="Export daily numbers" />}
      />

      {earningsError ? (
        <Note>
          Shopify&apos;s earnings events could not be read for this connection, so gross earnings, fees and net earnings below may be empty. Charges and MRR do not need them. The error was: {earningsError}
        </Note>
      ) : null}

      <StatGrid ids={["mrr", "arr", "arpu", "ltv"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["netNewMrr", "nrr", "grr", "revenueChurnRate"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["charged", "grossEarned", "fees", "netEarned"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["feeRate", "refunded", "credits"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} columns={3} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="MRR" description="Monthly recurring revenue at the end of each period." data={single(rows, p.range, gran, { key: "mrr", label: "MRR", color: slotColor(0), read: readers.mrr }, "money", comparison)} kind="area" granularity={gran} />
        <ChartCard title="MRR movement" description="New and expansion MRR above zero, contraction and churn below." data={totals(rows, p.range, gran, MRR_MOVEMENT, "money")} kind="diverge" granularity={gran} />
        <ChartCard title="Earnings after Shopify's fee" description="Net earnings and the fee together make the gross earnings." data={totals(rows, p.range, gran, EARNINGS_SPLIT, "money")} kind="stack" granularity={gran} />
        <ChartCard title="Charged" description="What merchants were charged, before Shopify's fee." data={single(rows, p.range, gran, { key: "charged", label: "Charged", color: slotColor(0), read: readers.charged }, "money")} kind="stack" granularity={gran} />
      </div>

      <PlanMix rows={plans} date={p.range.to} />
    </>
  )
}
