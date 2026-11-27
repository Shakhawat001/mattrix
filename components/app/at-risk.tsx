import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FROZEN_DAYS_BACK, TRIAL_DAYS_AHEAD, type AtRisk, type AtRiskList } from "@/lib/analytics/at-risk"
import { AT_RISK_METRICS, type AtRiskMetricId } from "@/lib/analytics/metrics-registry"
import { formatDate } from "@/lib/analytics/range"
import { formatInt, formatMoney, formatValue } from "@/lib/format"
import { dayIn } from "@/lib/time-zone"
import { MetricHint } from "./metric-hint"

const billed = (billingPeriod: string | null) => (billingPeriod === "ANNUAL" ? "yearly" : "monthly")
const plural = (n: number, word: string) => `${formatInt(n)} ${n === 1 ? word : `${word}s`}`

/** How many shops each list on the card shows. */
export const AT_RISK_ROWS = 5

type Row = { appId: string; shop: string; planHandle: string | null; billingPeriod: string | null; monthlyCents: number }
type Item = { appId: string; shop: string; monthlyCents: number; detail: string }

/**
 * What may be lost soon or may come back, for the apps of a page: the subscriptions set to end, the
 * trials ending this week and the frozen subscriptions, each with its total and its first shops,
 * linked to their pages. Read for now, whatever the date range.
 */
export function AtRiskCard({ data, apps = [], carry, timeZone }: { data: AtRisk; apps?: { id: string; label: string }[]; carry: string; timeZone: string }) {
  const day = (d: Date) => formatDate(dayIn(d, timeZone))
  const { setToEnd, trialsEnding, frozen } = data
  // On a page with more than one app, each line says which app it is.
  const labels = new Map(apps.length > 1 ? apps.map((a) => [a.id, a.label]) : [])
  const items = <T extends Row>(list: AtRiskList<T>, when: (row: T) => string): Item[] =>
    list.rows.map((r) => ({
      appId: r.appId,
      shop: r.shop,
      monthlyCents: r.monthlyCents,
      detail: [labels.get(r.appId), `${r.planHandle ?? "Unnamed plan"}, ${billed(r.billingPeriod)}`, when(r)].filter(Boolean).join(", "),
    }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>At risk</CardTitle>
        <CardDescription>What may be lost soon or may come back, as of now, whatever the date range. Each shop links to its timeline.</CardDescription>
      </CardHeader>
      <CardContent>
        {setToEnd.count + trialsEnding.count + frozen.count === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing at risk right now: no subscription is set to end, no trial ends in the next {TRIAL_DAYS_AHEAD} days, and no subscription frozen in the last {FROZEN_DAYS_BACK} days is waiting to come back.
          </p>
        ) : (
          <dl className="grid gap-x-8 gap-y-6 lg:grid-cols-3">
            <Part
              id="mrrSetToEnd"
              value={setToEnd.mrrCents}
              note={setToEnd.count > 0 ? plural(setToEnd.count, "subscription") : null}
              items={items(setToEnd, (r) => `ends ${day(r.endsAt)}`)}
              total={setToEnd.count}
              cut="soonest"
              empty="No subscription is set to end."
              carry={carry}
            />
            <Part
              id="trialsEndingSoon"
              value={trialsEnding.count}
              note={trialsEnding.count > 0 ? `Would add ${formatMoney(trialsEnding.mrrCents)} to MRR` : null}
              items={items(trialsEnding, (r) => `trial ends ${day(r.endsAt)}`)}
              total={trialsEnding.count}
              cut="soonest"
              empty={`No trial ends in the next ${TRIAL_DAYS_AHEAD} days.`}
              carry={carry}
            />
            <Part
              id="frozenMrr"
              value={frozen.mrrCents}
              note={frozen.count > 0 ? plural(frozen.count, "subscription") : null}
              items={items(frozen, (r) => `frozen ${day(r.frozenAt)}`)}
              total={frozen.count}
              cut="latest"
              empty={`No subscription frozen in the last ${FROZEN_DAYS_BACK} days is waiting to come back.`}
              carry={carry}
            />
          </dl>
        )}
      </CardContent>
    </Card>
  )
}

function Part({
  id,
  value,
  note,
  items,
  total,
  cut,
  empty,
  carry,
}: {
  id: AtRiskMetricId
  value: number
  note: string | null
  items: Item[]
  /** How many there are in all; more than the items when the list was cut. */
  total: number
  /** Which end of the list is shown when it is cut. */
  cut: "soonest" | "latest"
  empty: string
  carry: string
}) {
  const def = AT_RISK_METRICS[id]
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {def.label}
        <MetricHint text={def.description} label={`What ${def.label} means`} />
      </dt>
      <dd className="mt-1 font-heading text-xl font-semibold">{formatValue(value, def.format)}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
      <dd className="mt-3">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {items.map((i) => (
              <li key={`${i.appId}:${i.shop}`} className="flex flex-col gap-0.5 py-2 text-sm first:pt-0 last:pb-0">
                <span className="flex items-baseline justify-between gap-3">
                  <Link href={`/apps/${i.appId}/shops/${encodeURIComponent(i.shop)}${carry}`} className="min-w-0 truncate font-medium underline-offset-4 hover:underline">
                    {i.shop}
                  </Link>
                  <span className="shrink-0 tabular-nums">{formatMoney(i.monthlyCents)}</span>
                </span>
                <span className="text-xs text-muted-foreground">{i.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {total > items.length ? <p className="mt-2 text-xs text-muted-foreground">{`The ${formatInt(items.length)} ${cut} of ${formatInt(total)}.`}</p> : null}
      </dd>
    </div>
  )
}
