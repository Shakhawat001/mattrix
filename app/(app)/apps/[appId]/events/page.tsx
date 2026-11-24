import type { Metadata } from "next"
import { ExportLink } from "@/components/app/export-link"
import { PageHeader } from "@/components/app/page-header"
import { PageNav } from "@/components/app/page-nav"
import { ParamSelect, SearchBox } from "@/components/app/table-controls"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { eventLabel, reasonLabel } from "@/lib/analytics/labels"
import type { SearchParams } from "@/lib/analytics/page-params"
import { listEventTypes, listEvents, type EventRow } from "@/lib/analytics/queries"
import { formatRange } from "@/lib/analytics/range"
import { loadDashboard } from "@/lib/analytics/scope"
import { oneOf, pageNumber, toParams, withParams } from "@/lib/analytics/url"
import { getDb } from "@/lib/db/client"
import { formatDateTime, formatMoney } from "@/lib/format"
import { requireSession } from "@/lib/auth/dal"

export const metadata: Metadata = { title: "Events" }

const PAGE_SIZE = 50

/** What the event says beyond its type: the plan, the money, the reason. */
function details(e: EventRow): string {
  const parts: string[] = []
  if (e.planHandle) parts.push(`${e.planHandle}${e.billingPeriod ? (e.billingPeriod === "ANNUAL" ? ", yearly" : ", monthly") : ""}`)
  if (e.amountCents !== null) parts.push(formatMoney(e.amountCents))
  if (e.netCents !== null) parts.push(`${formatMoney(e.netCents)} after fee`)
  if (e.reason) parts.push(e.reason.split(",").map((r) => reasonLabel(r.trim())).join(", "))
  if (e.reasonDescription) parts.push(`"${e.reasonDescription}"`)
  return parts.join(" | ")
}

export default async function EventsPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  const d = await loadDashboard(query, appId)
  const db = getDb()
  const types = await listEventTypes(db, [appId])
  const type = oneOf(query.type, types)
  const shop = (toParams(query).get("shop") ?? "").slice(0, 100)
  const page = pageNumber(query.page)

  const { rows, total } = await listEvents(db, [appId], { type, shop, range: d.params.range, page, pageSize: PAGE_SIZE })
  const current = toParams(query)
  const hrefFor = (n: number) => `/apps/${appId}/events?${withParams(current, { page: String(n) }).toString()}`
  const typeOptions = [{ value: "any", label: "Any event" }, ...types.map((t) => ({ value: t, label: eventLabel(t) }))]

  return (
    <>
      <PageHeader
        level={2}
        title="Events"
        description={`What Shopify reported, ${formatRange(d.params.range)}. Every number in the dashboard is built from these.`}
        actions={<ExportLink params={{ kind: "events", app: appId, from: d.params.range.from, to: d.params.range.to, type, shop }} />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox name="shop" value={shop} placeholder="Search shops" />
        <ParamSelect name="type" value={type ?? "any"} options={typeOptions} label="Event type" className="min-w-44" />
      </div>

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Shop</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    No events match.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(e.occurredAt)}</TableCell>
                    <TableCell>
                      <Badge variant="default">{eventLabel(e.type)}</Badge>
                    </TableCell>
                    <TableCell className="font-medium">{e.shop ?? ""}</TableCell>
                    <TableCell className="max-w-96 truncate text-muted-foreground" title={details(e) || undefined}>
                      {details(e)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <PageNav page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </>
  )
}
