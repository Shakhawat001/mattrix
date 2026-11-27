import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Note, PageHeader } from "@/components/app/page-header"
import { PeriodsTable, ShopFacts, StaysTable, TimelineCard, TrialsTable } from "@/components/app/shop-timeline"
import { buttonVariants } from "@/components/ui/button"
import { listExcludedShops } from "@/lib/analytics/excluded-shops"
import type { SearchParams } from "@/lib/analytics/page-params"
import { getTimeZone, requireVisibleApp } from "@/lib/analytics/scope"
import { getShopTimeline } from "@/lib/analytics/shop-timeline"
import { parseShopParam, shopStanding, timelineRows } from "@/lib/analytics/shop-timeline-view"
import { getShopTotals } from "@/lib/analytics/shop-totals"
import { carriedFrom } from "@/lib/analytics/url"
import { getDb } from "@/lib/db/client"
import { requireSession } from "@/lib/auth/dal"

type Props = { params: Promise<{ appId: string; shop: string }>; searchParams: Promise<SearchParams> }

// The title repeats the address bar; nothing is read for it.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { shop } = await params
  return { title: parseShopParam(shop) ?? "Shop" }
}

export default async function ShopTimelinePage({ params, searchParams }: Props) {
  await requireSession()
  const [{ appId, shop: segment }, query] = await Promise.all([params, searchParams])
  await requireVisibleApp(appId)
  const shop = parseShopParam(segment)
  if (!shop) notFound()

  const db = getDb()
  const [timeline, totals, excludedShops, timeZone] = await Promise.all([getShopTimeline(db, appId, shop), getShopTotals(db, appId, shop), listExcludedShops(db), getTimeZone()])
  if (!timeline) notFound()
  // An excluded shop's events are kept, but no stays, periods or trials are built from them.
  const excluded = excludedShops.some((s) => s.shop === timeline.shop)

  return (
    <>
      <PageHeader
        level={2}
        title={timeline.shop}
        description="Everything Shopify reported about this shop in this app, in order: every stay, plan, trial, charge and uninstall. Not limited by the date range."
        actions={
          <Link href={`/apps/${appId}/shops${carriedFrom(query)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            All shops
          </Link>
        }
      />

      {excluded ? (
        <Note>
          You excluded this shop, so it counts in no number and has no stays, plans or trials worked out. Its events are kept and shown below as Shopify reported them.{" "}
          <Link href="/settings#excluded-shops" className="font-medium text-foreground underline underline-offset-4">
            Count it again in Settings
          </Link>
          .
        </Note>
      ) : (
        <ShopFacts standing={shopStanding(timeline)} totals={totals} timeZone={timeZone} />
      )}

      <TimelineCard rows={timelineRows(timeline, timeZone)} shown={timeline.events.length} total={timeline.eventCount} timeZone={timeZone} />

      {excluded ? null : (
        <>
          <StaysTable stays={timeline.stays} timeZone={timeZone} />
          <PeriodsTable periods={timeline.subscriptions} timeZone={timeZone} />
          <TrialsTable trials={timeline.trials} timeZone={timeZone} />
        </>
      )}
    </>
  )
}
