import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TimelineStay, TimelineSubscription, TimelineTrial } from "@/lib/analytics/shop-timeline"
import { reasonsLabel, type ShopStanding, type TimelineRow } from "@/lib/analytics/shop-timeline-view"
import type { ShopTotals } from "@/lib/analytics/shop-totals"
import { formatDateTime, formatInt, formatMoney } from "@/lib/format"

// The parts of one shop's page: where it stands, its story, and the stays, subscription
// periods and trials the numbers are built from.

const billed = (billingPeriod: string | null) => (billingPeriod === "ANNUAL" ? "yearly" : "monthly")

/** The shop now: installed or not, its plan, its MRR, how often it installed, what it has paid. */
export function ShopFacts({ standing, totals }: { standing: ShopStanding; totals: ShopTotals }) {
  const { plan } = standing
  const earned = [
    totals.netEarnedCents === null ? null : `${formatMoney(totals.netEarnedCents)} net earnings`,
    totals.refundedCents > 0 ? `${formatMoney(totals.refundedCents)} refunded` : null,
  ].filter(Boolean)
  const facts: { label: string; value: string; note: string | null }[] = [
    {
      label: "Status",
      value: standing.installed === null ? "Unknown" : standing.installed ? "Installed" : "Uninstalled",
      note: standing.since === null ? "No install or uninstall in the data" : `${standing.installed ? "Since" : "Left"} ${formatDateTime(standing.since)}`,
    },
    {
      label: "Plan now",
      value: plan.status === "paying" ? `${plan.planHandle ?? "Unnamed plan"}, ${billed(plan.billingPeriod)}` : plan.status === "trial" ? "Free trial" : plan.status === "free" ? "Free" : "None",
      note:
        plan.status === "trial"
          ? `Of ${plan.planHandle ?? "an unnamed plan"}, ends ${formatDateTime(plan.trialEndsAt)}`
          : plan.status === "free" && plan.planHandle
            ? `On ${plan.planHandle}, at no charge`
            : null,
    },
    {
      label: "MRR",
      value: formatMoney(standing.mrrCents),
      note: plan.status === "trial" ? `${formatMoney(plan.monthlyCents)} once the trial converts` : plan.status === "paying" && plan.billingPeriod === "ANNUAL" ? "A twelfth of the yearly price" : null,
    },
    { label: "Installs", value: formatInt(standing.installs), note: standing.firstInstalledAt ? `First ${formatDateTime(standing.firstInstalledAt)}` : "None in the data" },
    { label: "Charged in all", value: formatMoney(totals.chargedCents), note: earned.length ? earned.join(", ") : null },
  ]

  return (
    <Card size="sm">
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-xs tracking-wider text-muted-foreground uppercase">{f.label}</dt>
              <dd className="mt-1 truncate font-heading text-xl font-semibold" title={f.value}>
                {f.value}
              </dd>
              {f.note ? <dd className="mt-0.5 text-xs text-muted-foreground">{f.note}</dd> : null}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  )
}

const TONE = { loss: "destructive", money: "secondary", plain: "default" } as const

/** The story, one row per event or trial step, oldest first. */
export function TimelineCard({ rows, shown, total }: { rows: TimelineRow[]; shown: number; total: number }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">Timeline</CardTitle>
        <CardDescription className="text-xs">
          Oldest first, every time in UTC. Each row is an event Shopify reported, except the start and end of a free trial, which are worked out from them.
          {total > shown ? ` Showing the latest ${formatInt(shown)} of ${formatInt(total)} events; the tables below still cover the whole history.` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col divide-y">
          {rows.map((r) => (
            <li key={r.key} className="grid gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[10.5rem_minmax(0,1fr)]">
              <time dateTime={r.at.toISOString()} className="text-xs text-muted-foreground tabular-nums sm:pt-0.5">
                {formatDateTime(r.at)}
              </time>
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Badge variant={TONE[r.tone]}>{r.title}</Badge>
                  {r.detail ? <span className="text-sm text-muted-foreground">{r.detail}</span> : null}
                </p>
                {r.quote ? <blockquote className="border-l-2 pl-3 text-sm leading-relaxed break-words whitespace-pre-wrap">&ldquo;{r.quote}&rdquo;</blockquote> : null}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}

function TableCard({ title, description, empty, children }: { title: string; description: string; empty: string | null; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">{empty ? <p className="px-(--card-spacing) py-2 text-sm text-muted-foreground">{empty}</p> : children}</CardContent>
    </Card>
  )
}

export function StaysTable({ stays }: { stays: TimelineStay[] }) {
  return (
    <TableCard title="Stays" description="Each install, to its uninstall." empty={stays.length === 0 ? "No install of this shop is in the data." : null}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Install</TableHead>
            <TableHead>Installed</TableHead>
            <TableHead>Uninstalled</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stays.map((s) => (
            <TableRow key={`${s.seq}-${s.installedAt.getTime()}`}>
              <TableCell className="tabular-nums">{formatInt(s.seq)}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(s.installedAt)}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{s.uninstalledAt ? formatDateTime(s.uninstalledAt) : "Still installed"}</TableCell>
              <TableCell className="max-w-56 truncate text-muted-foreground" title={s.reason ?? undefined}>
                {s.uninstalledAt ? (reasonsLabel(s.reason) ?? "No reason given") : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}

const END_REASON: Record<string, string> = { canceled: "Canceled", uninstalled: "Uninstalled", frozen: "Frozen", replaced: "Plan changed" }

export function PeriodsTable({ periods }: { periods: TimelineSubscription[] }) {
  return (
    <TableCard
      title="Subscription periods"
      description="One per plan and price. A yearly price counts at a twelfth of itself each month."
      empty={periods.length === 0 ? "This shop has no subscription in the data." : null}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Start</TableHead>
            <TableHead>End</TableHead>
            <TableHead>End reason</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead className="text-right">Monthly price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.map((p) => (
            <TableRow key={`${p.startedAt.getTime()}-${p.endedAt?.getTime() ?? "open"}`}>
              <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(p.startedAt)}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{p.endedAt ? formatDateTime(p.endedAt) : "Still open"}</TableCell>
              <TableCell className="text-muted-foreground">{p.endReason ? (END_REASON[p.endReason] ?? p.endReason) : ""}</TableCell>
              <TableCell>{`${p.planHandle ?? "Unnamed plan"}, ${billed(p.billingPeriod)}`}</TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(p.monthlyCents)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}

const OUTCOME: Record<TimelineTrial["outcome"], string> = { converted: "Converted", canceled: "Canceled", open: "Running" }

export function TrialsTable({ trials }: { trials: TimelineTrial[] }) {
  return (
    <TableCard title="Free trials" description="A trial converts when it ends with the subscription still open." empty={trials.length === 0 ? "This shop has had no free trial." : null}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Start</TableHead>
            <TableHead>End</TableHead>
            <TableHead className="text-right">Days</TableHead>
            <TableHead>Outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trials.map((t) => (
            <TableRow key={t.startedAt.getTime()}>
              <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(t.startedAt)}</TableCell>
              <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(t.resolvedAt ?? t.endsAt)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(t.trialDays)}</TableCell>
              <TableCell>{OUTCOME[t.outcome] ?? t.outcome}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableCard>
  )
}
