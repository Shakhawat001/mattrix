import type { Metadata } from "next"
import { ChurnByCause } from "@/components/app/churn-by-cause"
import { StatGrid } from "@/components/app/kpi-card"
import { PageHeader } from "@/components/app/page-header"
import { WinBackCard } from "@/components/app/win-back"
import { BarList } from "@/components/charts/bar-list"
import { ChartCard } from "@/components/charts/chart-card"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { reasonLabel } from "@/lib/analytics/labels"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getExplanations, getReasons } from "@/lib/analytics/queries"
import { formatDate, formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { slotColor } from "@/lib/analytics/series"
import { readers, totals } from "@/lib/analytics/view"
import { getWinBack } from "@/lib/analytics/win-back"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Churn" }

export default async function ChurnPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const { params: p, rows, points, kpis, comparedKpis, caption } = d
  const gran = p.granularity
  const db = getDb()
  const [reasons, comments, winBack] = await Promise.all([getReasons(db, [appId], p.range), getExplanations(db, [appId], p.range, 20), getWinBack(db, p.appIds, p.range)])

  return (
    <>
      <PageHeader level={2} title="Churn" description={`Why shops leave, ${formatRange(p.range)}.`} />

      <StatGrid ids={["uninstalls", "uninstallRate", "canceledSubs", "churnedMrr"]} kpis={kpis} compared={comparedKpis} caption={caption} points={points} />

      <ChurnByCause kpis={kpis} compared={comparedKpis} caption={caption} points={points} rows={rows} range={p.range} granularity={gran} />

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Uninstalls" description="Shops that removed the app in each period." data={totals(rows, p.range, gran, [{ key: "uninstalls", label: "Uninstalls", color: slotColor(0), read: readers.uninstalls }], "int")} kind="stack" granularity={gran} />

        <Card>
          <CardHeader>
            <CardTitle>Reasons given</CardTitle>
            <CardDescription>From the survey Shopify shows a merchant when they uninstall. A shop can give more than one reason, and many give none.</CardDescription>
          </CardHeader>
          <CardContent>
            <BarList rows={reasons.slice(0, 10).map((r) => ({ label: reasonLabel(r.reason), value: r.count }))} empty="No uninstalls in this range." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>In their own words</CardTitle>
          <CardDescription>The most recent comments merchants left when they uninstalled, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {comments.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No comments in this range.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {comments.map((c, i) => (
                <li key={`${c.shop}-${c.at.getTime()}-${i}`} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <p className="text-sm leading-relaxed">&ldquo;{c.text}&rdquo;</p>
                  <p className="text-xs text-muted-foreground">
                    {c.shop}, {formatDate(c.at.toISOString().slice(0, 10))}
                    {c.reason ? `, ${c.reason.split(",").map((r) => reasonLabel(r.trim())).join(", ")}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <WinBackCard data={winBack} />
    </>
  )
}
