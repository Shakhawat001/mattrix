import type { Metadata } from "next"
import { PageHeader } from "@/components/app/page-header"
import { RebuildNotice } from "@/components/app/rebuild-notice"
import { AddConnectionForm } from "@/components/settings/add-connection-form"
import { Annotations } from "@/components/settings/annotations"
import { ApiTokensSection } from "@/components/settings/api-tokens-section"
import { AppForm } from "@/components/settings/app-form"
import { ConnectionActions } from "@/components/settings/connection-actions"
import { ExcludedShops } from "@/components/settings/excluded-shops"
import { SignOutEverywhere } from "@/components/settings/sign-out-everywhere"
import { TimeZoneForm, type ZoneOption } from "@/components/settings/time-zone-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ALL_APPS, FIRST_ANNOTATION_DATE, lastAnnotationDate, listAnnotations } from "@/lib/analytics/annotations"
import { listExcludedShops } from "@/lib/analytics/excluded-shops"
import { getConnections, type ConnectionOverview } from "@/lib/analytics/queries"
import { addDays, formatDate } from "@/lib/analytics/range"
import { getApps, getTimeZone } from "@/lib/analytics/scope"
import { appColors, swatchColor } from "@/lib/analytics/series"
import { requireSession } from "@/lib/auth/dal"
import { countActiveSessions } from "@/lib/auth/sessions"
import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"
import { formatAgo, formatDateTime, formatInt } from "@/lib/format"
import { dayIn, describeTimeZone, timeZoneNames, todayIn } from "@/lib/time-zone"

export const metadata: Metadata = { title: "Settings" }

type Tone = "ok" | "wait" | "bad"
const DOT: Record<Tone, string> = { ok: "var(--delta-good)", wait: "var(--muted-foreground)", bad: "var(--delta-bad)" }

function statusOf(c: ConnectionOverview, now: Date): { text: string; tone: Tone } {
  if (c.isDemo) return { text: "Demo data. It is never sent to or read from Shopify.", tone: "wait" }
  if (c.paused) return { text: "Paused", tone: "wait" }
  if (c.syncRequestedAt) return { text: "Sync requested, starting soon", tone: "wait" }
  if (c.lastError) return { text: "The last sync failed", tone: "bad" }
  if (!c.lastOkAt) return { text: "Waiting for the first sync", tone: "wait" }
  return { text: `Up to date, synced ${formatAgo(c.lastOkAt, now)}`, tone: "ok" }
}

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="mt-0.5 text-sm">{children}</dd>
  </div>
)

export default async function SettingsPage() {
  await requireSession()
  const db = getDb()
  const [connections, apps, sessions, timeZone] = await Promise.all([getConnections(db), getApps(), countActiveSessions(db), getTimeZone()])
  const excludedShops = await listExcludedShops(db)
  const annotations = await listAnnotations(db)
  const env = getEnv()
  const colors = appColors(apps)
  const now = new Date()
  // Each zone with its offset today, so a city that is hard to place still says where its clock is.
  const zones: ZoneOption[] = timeZoneNames().map((zone) => ({ value: zone, label: describeTimeZone(zone, now) }))

  return (
    <>
      <RebuildNotice />
      <PageHeader description="Where the numbers come from, how your apps appear, which time zone days are counted in, and who is signed in." />

      <section aria-labelledby="connections" className="flex flex-col gap-4">
        <h2 id="connections" className="font-heading text-base font-medium">
          Connections
        </h2>

        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is connected yet. Add your Shopify Partner API token below to read your apps.</p>
        ) : null}

        {connections.map((c) => {
          const status = statusOf(c, now)
          return (
            <Card key={c.id}>
              <CardHeader>
                <CardTitle>{c.label}</CardTitle>
                <CardDescription className="flex items-center gap-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: DOT[status.tone] }} aria-hidden />
                  {status.text}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-5">
                <ConnectionActions id={c.id} label={c.label} paused={c.paused} isDemo={c.isDemo} />

                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
                  {c.isDemo ? null : (
                    <>
                      <Detail label="Partner ID">{c.partnerId}</Detail>
                      <Detail label="Token">
                        <span className="tabular-nums">{"••••"}{c.tokenHint}</span>
                      </Detail>
                      <Detail label="API version">{c.apiVersion}</Detail>
                      <Detail label="Reads">{c.appGids.length > 0 ? `${c.appGids.length} chosen apps` : "Every app"}</Detail>
                      {/* A date kept as midnight UTC of it, so it is read back as that date. */}
                      <Detail label="History from">{formatDate(c.backfillFrom.toISOString().slice(0, 10))}</Detail>
                    </>
                  )}
                  <Detail label="Apps">{formatInt(c.apps)}</Detail>
                  <Detail label="Events stored">{formatInt(c.events)}</Detail>
                  {c.lastOkAt ? <Detail label="Last good sync">{formatDateTime(c.lastOkAt, timeZone)}</Detail> : null}
                </dl>

                {c.lastError ? (
                  <p role="alert" className="border-l-2 border-destructive bg-muted px-4 py-3 text-sm leading-relaxed">
                    The last sync failed: {c.lastError}
                  </p>
                ) : null}
                {c.earningsError && !c.lastError ? (
                  <p className="border-l-2 border-primary bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    Installs, subscriptions and charges were read, but Shopify&apos;s earnings events were not: {c.earningsError}. Gross earnings, fees and net earnings stay empty until that is fixed.
                  </p>
                ) : null}
                {c.legacyError && !c.lastError ? (
                  <p className="border-l-2 border-primary bg-muted px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    The billing screen events (charges accepted, declined or left to expire) could not be read from Shopify&apos;s older App.events: {c.legacyError}. Everything else still syncs.
                  </p>
                ) : null}

                {c.runs.length > 0 ? (
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-muted">
                        <TableRow>
                          <TableHead>Recent syncs</TableHead>
                          <TableHead>Started by</TableHead>
                          <TableHead>Result</TableHead>
                          <TableHead className="text-right">New events</TableHead>
                          <TableHead className="text-right">Took</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {c.runs.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="text-muted-foreground tabular-nums">{formatDateTime(r.startedAt, timeZone)}</TableCell>
                            <TableCell className="text-muted-foreground">{r.trigger === "manual" ? "You" : r.trigger === "startup" ? "First run" : "Schedule"}</TableCell>
                            <TableCell className="max-w-72 truncate" title={r.error ?? undefined}>
                              {r.ok === null ? "Running" : r.ok ? "Succeeded" : `Failed${r.error ? `: ${r.error}` : ""}`}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{formatInt(r.eventsInserted)}</TableCell>
                            <TableCell className="text-right text-muted-foreground tabular-nums">{r.durationMs === null ? "" : `${(r.durationMs / 1000).toFixed(1)} s`}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          )
        })}

        <Card>
          <CardHeader>
            <CardTitle>Add a connection</CardTitle>
            <CardDescription>
              One Shopify Partner API token reads every app in your Partner organization. Create the token in your Partner organization settings with permission to view apps only, then paste it here. The steps are in docs/SELF_HOSTING.md. This dashboard only ever reads.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddConnectionForm defaultFrom={addDays(todayIn(timeZone, now), -365 * 3)} />
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="apps" className="flex flex-col gap-4">
        <h2 id="apps" className="font-heading text-base font-medium">
          Apps
        </h2>
        <Card>
          <CardContent className="divide-y">
            {apps.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Apps appear here after the first sync.</p>
            ) : (
              apps.map((a) => (
                <AppForm
                  key={a.id}
                  app={{ id: a.id, shopifyName: a.shopifyName, displayName: a.displayName, color: a.color, shownColor: swatchColor(colors, a.id), hidden: a.hidden, connectionLabel: a.connectionLabel }}
                />
              ))
            )}
          </CardContent>
        </Card>
      </section>

      <ExcludedShops shops={excludedShops.map((s) => ({ shop: s.shop, note: s.note, added: formatDate(dayIn(s.createdAt, timeZone)) }))} />

      <Annotations
        annotations={annotations.map((a) => ({ id: a.id, date: formatDate(a.date), app: a.appId === null ? null : (apps.find((p) => p.id === a.appId)?.label ?? "Unknown app"), label: a.label, note: a.note }))}
        apps={[{ value: ALL_APPS, label: "All apps" }, ...apps.map((a) => ({ value: a.id, label: a.label }))]}
        dates={{ initial: todayIn(timeZone, now), min: FIRST_ANNOTATION_DATE, max: lastAnnotationDate(todayIn(timeZone, now)) }}
      />

      <ApiTokensSection />

      <section aria-labelledby="system" className="flex flex-col gap-4">
        <h2 id="system" className="font-heading text-base font-medium">
          System
        </h2>
        <Card>
          <CardContent className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Detail label="Signed in now">{formatInt(sessions)} {sessions === 1 ? "browser" : "browsers"}</Detail>
              <Detail label="Reads Shopify">{env.demoMode ? "Never (demo mode)" : `Every ${env.syncIntervalMinutes} minutes`}</Detail>
              <Detail label="Days end at">Midnight, {describeTimeZone(timeZone, now)}</Detail>
              <Detail label="Times shown in">{describeTimeZone(timeZone, now)}</Detail>
            </dl>
            <TimeZoneForm current={timeZone} zones={zones} />
            <div>
              <SignOutEverywhere />
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  )
}
