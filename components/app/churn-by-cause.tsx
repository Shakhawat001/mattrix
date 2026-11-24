import { ChartCard } from "@/components/charts/chart-card"
import type { DayRow, Kpis, SeriesPoint } from "@/lib/analytics/aggregate"
import type { Granularity, Range } from "@/lib/analytics/range"
import { CHURN_BY_CAUSE, totals } from "@/lib/analytics/view"
import { StatGrid } from "./kpi-card"
import { SectionTitle } from "./page-header"

/** Losses split by cause (the store went inactive, or the merchant left), and the stores Shopify deactivated and reactivated. */
export function ChurnByCause({
  kpis,
  compared,
  caption,
  points,
  rows,
  range,
  granularity,
}: {
  kpis: Kpis
  compared: Kpis | null
  caption: string
  points: SeriesPoint[]
  rows: DayRow[]
  range: Range
  granularity: Granularity
}) {
  return (
    <section className="flex flex-col gap-4">
      <SectionTitle level={3} description="Store inactive means the store closed, paused or stopped paying Shopify: no app can win back a store that closed, so merchant left is the churn you can act on.">
        Churn by cause
      </SectionTitle>
      <StatGrid
        ids={["churnedMrrStoreInactive", "churnedMrrMerchantLeft", "canceledSubsStoreInactive", "canceledSubsMerchantLeft", "uninstallsStoreInactive", "uninstallsMerchantLeft", "deactivations", "reactivations"]}
        kpis={kpis}
        compared={compared}
        caption={caption}
        points={points}
      />
      <ChartCard
        title="Churned MRR by cause"
        description="Store inactive and merchant left together make the churned MRR of each period."
        data={totals(rows, range, granularity, CHURN_BY_CAUSE, "money")}
        kind="stack"
        granularity={granularity}
      />
    </section>
  )
}
