import type { Metadata } from "next"
import { EarningsBreakdown } from "@/components/app/earnings-breakdown"
import { ExportLink } from "@/components/app/export-link"
import { StatGrid } from "@/components/app/kpi-card"
import { Note, PageHeader } from "@/components/app/page-header"
import { RebuildNotice } from "@/components/app/rebuild-notice"
import { PlanMix } from "@/components/app/plan-mix"
import { ChartCard } from "@/components/charts/chart-card"
import { getEarningsBreakdown } from "@/lib/analytics/earnings"
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
  const [plans, connections, breakdown] = await Promise.all([
    getPlanMix(db, [appId], p.range.to, p.timeZone),
    getConnections(db),
    getEarningsBreakdown(db, appId, p.range, p.timeZone),
  ])
  const connection = connections.find((c) => c.id === scope[0]?.connectionId)
  const earningsError = connection?.earningsError ?? null
  const transactionsError = connection?.transactionsError ?? null

  return (
    <>
      <RebuildNotice />
      <PageHeader
        level={2}
        title="Revenue"
        description={`Recurring revenue and what reached you, ${formatRange(p.range)}.`}
        actions={<ExportLink params={{ kind: "daily", from: p.range.from, to: p.range.to, apps: appId }} label="Export daily numbers" />}
      />

      {earningsError && transactionsError ? (
        <Note>
          Neither Shopify&apos;s earnings events nor its payout records could be read on the last sync, so gross earnings, fees and net earnings below may be missing for recent days. Charges and MRR do not need them. Both usually need the View financials permission. The errors were: {earningsError}; {transactionsError}
        </Note>
      ) : earningsError ? (
        <Note>
          Shopify&apos;s earnings events could not be read on the last sync.{" "}
          {breakdown.ledgerUntil ? "Earnings come from its payout records, which were read, so nothing below is missing for that." : "Gross earnings, fees and net earnings below may be empty. Charges and MRR do not need them."} The error was: {earningsError}
        </Note>
      ) : transactionsError ? (
        <Note>
          Shopify&apos;s payout records could not be read on the last sync, so the days after they were last read come from the earning events, which leave out the 2.9% processing fee and any regulatory operating fee. If the error is about access, the token needs the View financials permission. The error was: {transactionsError}
        </Note>
      ) : null}

      <StatGrid ids={["mrr", "arr", "arpu", "ltv"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["netNewMrr", "nrr", "grr", "revenueChurnRate"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["charged", "grossEarned", "fees", "netEarned"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />
      <StatGrid ids={["feeRate", "refunded", "credits"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} columns={3} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="MRR" description="Monthly recurring revenue at the end of each period." data={single(rows, p.range, gran, { key: "mrr", label: "MRR", color: slotColor(0), read: readers.mrr }, "money", comparison)} kind="area" granularity={gran} />
        <ChartCard title="MRR movement" description="New and expansion MRR above zero, contraction and churn below." data={totals(rows, p.range, gran, MRR_MOVEMENT, "money")} kind="diverge" granularity={gran} />
        <ChartCard title="Earnings after Shopify's fees" description="Net earnings and Shopify's fees together make the gross earnings." data={totals(rows, p.range, gran, EARNINGS_SPLIT, "money")} kind="stack" granularity={gran} />
        <ChartCard title="Charged" description="What merchants were billed, before Shopify's fees and any credit, on the day of each charge." data={single(rows, p.range, gran, { key: "charged", label: "Charged", color: slotColor(0), read: readers.charged }, "money")} kind="stack" granularity={gran} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <EarningsBreakdown breakdown={breakdown} range={formatRange(p.range)} timeZone={p.timeZone} now={new Date()} isDemo={connection?.isDemo ?? false} recordsError={transactionsError} />
        <PlanMix rows={plans} date={p.range.to} />
      </div>
    </>
  )
}
