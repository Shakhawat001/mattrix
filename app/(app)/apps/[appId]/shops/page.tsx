import type { Metadata } from "next"
import Link from "next/link"
import { ExcludeShopButton } from "@/components/app/exclude-shop-button"
import { ExportLink } from "@/components/app/export-link"
import { PageHeader } from "@/components/app/page-header"
import { PageNav } from "@/components/app/page-nav"
import { ParamSelect, SearchBox } from "@/components/app/table-controls"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listExcludedShops } from "@/lib/analytics/excluded-shops"
import { reasonLabel } from "@/lib/analytics/labels"
import type { SearchParams } from "@/lib/analytics/page-params"
import { listShops } from "@/lib/analytics/queries"
import { formatDate } from "@/lib/analytics/range"
import { getTimeZone, requireVisibleApp } from "@/lib/analytics/scope"
import { carriedFrom, oneOf, pageNumber, toParams, withParams } from "@/lib/analytics/url"
import { getDb } from "@/lib/db/client"
import { formatInt, formatMoney } from "@/lib/format"
import { requireSession } from "@/lib/auth/dal"
import { dayIn } from "@/lib/time-zone"

export const metadata: Metadata = { title: "Shops" }

const PAGE_SIZE = 50
const STATUS = [{ value: "any", label: "Any status" }, { value: "installed", label: "Installed" }, { value: "uninstalled", label: "Uninstalled" }]
const PLAN = [{ value: "any", label: "Any plan" }, { value: "paying", label: "Paying now" }, { value: "trial", label: "In a free trial" }, { value: "free", label: "Free, installed" }, { value: "churned", label: "Paid before, not now" }]
const SORT = [{ value: "recent", label: "Newest install" }, { value: "mrr", label: "Highest MRR" }, { value: "revenue", label: "Most charged" }, { value: "shop", label: "Shop name" }]

export default async function ShopsPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<SearchParams> }) {
  await requireSession()
  const [{ appId }, query] = await Promise.all([params, searchParams])
  await requireVisibleApp(appId)
  const q = (toParams(query).get("q") ?? "").slice(0, 100)
  const status = oneOf(query.status, ["installed", "uninstalled"] as const)
  const plan = oneOf(query.plan, ["paying", "trial", "free", "churned"] as const)
  const sort = oneOf(query.sort, ["recent", "mrr", "revenue", "shop"] as const) ?? "recent"
  const page = pageNumber(query.page)

  const [{ rows, total }, timeZone] = await Promise.all([listShops(getDb(), [appId], { q, status, plan, sort, page, pageSize: PAGE_SIZE }), getTimeZone()])
  // Excluded shops leave this list at the next rebuild; until then their row says so.
  const excluded = new Set((await listExcludedShops(getDb())).map((s) => s.shop))
  const current = toParams(query)
  const hrefFor = (n: number) => `/apps/${appId}/shops?${withParams(current, { page: String(n) }).toString()}`
  const carry = carriedFrom(query)

  return (
    <>
      <PageHeader
        level={2}
        title="Shops"
        description="Every shop that has installed the app, where it stands, and what it has paid. Not limited by the date range. Exclude your own test stores to leave them out of every number."
        actions={<ExportLink params={{ kind: "shops", app: appId, q, status, plan, sort }} />}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox name="q" value={q} placeholder="Search shops" />
        <ParamSelect name="status" value={status ?? "any"} options={STATUS} label="Status" />
        <ParamSelect name="plan" value={plan ?? "any"} options={PLAN} label="Plan" />
        <ParamSelect name="sort" value={sort} options={SORT} label="Sort by" />
      </div>

      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              <TableHead>Shop</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">MRR</TableHead>
              <TableHead className="text-right">Charged in all</TableHead>
              <TableHead className="text-right">Installs</TableHead>
              <TableHead>First installed</TableHead>
              <TableHead>Left</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>
                <span className="sr-only">Exclude</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                  No shops match.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((s) => (
                <TableRow key={`${s.appId}-${s.shop}`}>
                  <TableCell className="font-medium">
                    <Link href={`/apps/${appId}/shops/${encodeURIComponent(s.shop)}${carry}`} className="underline-offset-4 hover:underline">
                      {s.shop}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.installed ? "default" : "secondary"}>{s.installed ? "Installed" : "Uninstalled"}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.subscribed || s.inTrial ? `${s.planHandle ?? "Plan"}, ${s.billingPeriod === "ANNUAL" ? "yearly" : "monthly"}${s.inTrial ? ", in trial" : ""}` : s.installed ? "Free" : "None"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.subscribed ? formatMoney(s.monthlyCents) : "n/a"}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.charged > 0 ? formatMoney(s.charged) : "n/a"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatInt(s.installs)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatDate(dayIn(s.firstInstalledAt, timeZone))}</TableCell>
                  <TableCell className="text-muted-foreground">{s.uninstalledAt ? formatDate(dayIn(s.uninstalledAt, timeZone)) : ""}</TableCell>
                  <TableCell className="max-w-56 truncate text-muted-foreground" title={s.reason ?? undefined}>
                    {s.reason ? s.reason.split(",").map((r) => reasonLabel(r.trim())).join(", ") : ""}
                  </TableCell>
                  <TableCell className="text-right">
                    <ExcludeShopButton shop={s.shop} excluded={excluded.has(s.shop)} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <PageNav page={page} pageSize={PAGE_SIZE} total={total} hrefFor={hrefFor} />
    </>
  )
}
