import type { Metadata } from "next"
import { StatGrid } from "@/components/app/kpi-card"
import { PageHeader } from "@/components/app/page-header"
import { OutcomeBar } from "@/components/charts/bar-list"
import { ChartCard } from "@/components/charts/chart-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getTrialStats } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { TRIAL_FLOW, totals } from "@/lib/analytics/view"
import { getDb } from "@/lib/db/client"
import { formatDays, formatInt } from "@/lib/format"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Trials" }

export default async function TrialsPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption } = d
  const gran = p.granularity
  const trials = await getTrialStats(getDb(), [appId], p.range)

  return (
    <>
      <PageHeader level={2} title="Trials" description={`Free trials and what became of them, ${formatRange(p.range)}. A trial converts when it ends with the subscription still open.`} />

      <StatGrid ids={["trialsStarted", "trialsConverted", "trialsCanceled", "trialConversion"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Trials over time" description="Trials started, converted to a paid charge, and canceled before one. Each is counted on the day it happened." data={totals(rows, p.range, gran, TRIAL_FLOW, "int")} kind="line" granularity={gran} />

        <Card>
          <CardHeader>
            <CardTitle>Where the trials that started in this range ended up</CardTitle>
            <CardDescription>
              {formatInt(trials.started)} trials started. {trials.medianDaysToConvert === null ? "None has converted yet." : `Half of the converters paid within ${formatDays(trials.medianDaysToConvert)}.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <OutcomeBar
              parts={[
                { label: "Converted to paid", value: trials.converted, color: slotColor(0) },
                { label: "Canceled", value: trials.canceled, color: slotColor(1) },
                { label: "Still running", value: trials.open, color: slotColor(2) },
              ]}
            />
          </CardContent>
        </Card>
      </div>
    </>
  )
}
