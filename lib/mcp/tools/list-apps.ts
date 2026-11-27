import { z } from "zod"
import { getConnections, type AppInfo, type ConnectionOverview } from "@/lib/analytics/queries"
import { BRAND } from "@/lib/brand"
import { envelope, instant, NOTES } from "../output"
import { defineTool } from "../tool"

/** Whether a connection's Partner API token can read earnings: false when Shopify refused them on the last sync, null until a sync has finished and shown either way. */
export function earningsReadable(c: Pick<ConnectionOverview, "isDemo" | "earningsError" | "lastOkAt" | "lastError">): boolean | null {
  if (c.isDemo) return true
  if (c.earningsError !== null) return false
  // Earnings are read only after the core pass succeeds, so a failed sync says nothing about them.
  if (c.lastOkAt === null || c.lastError !== null) return null
  return true
}

/** list_apps's answer, from the apps the caller may see and every connection. */
export function describeApps(apps: AppInfo[], connections: ConnectionOverview[], timeZone: string) {
  const notes: string[] = []
  for (const c of connections) {
    if (c.isDemo) notes.push(`${c.label} holds demo data made up by the seed-demo command. None of it is real.`)
    else if (c.lastOkAt === null) notes.push(`${c.label} has not finished a sync yet, so its apps may have no numbers.`)
    if (c.lastError !== null) notes.push(`The last sync of ${c.label} failed, so its apps' numbers may be out of date. last_error says why.`)
    if (c.paused && !c.isDemo) notes.push(`${c.label} is paused: it does not sync until it is resumed in Settings.`)
    if (earningsReadable(c) === false) {
      notes.push(`Shopify refused the earnings events to the Partner API token of ${c.label}, so gross earnings, fees and net earnings are empty for its apps. MRR, charges and installs do not need them.`)
    }
    if (c.legacyError !== null) notes.push(`The billing screen events of ${c.label} (charges accepted, declined and expired) could not be read on the last sync. Everything else synced. billing_events_error says why.`)
  }
  notes.push(connections.length > 0 ? NOTES.historyStartsAtBackfill : "Nothing is connected yet. A Shopify Partner API token is added in Settings.")

  return envelope(
    {
      apps: apps.map((a) => ({
        id: a.id,
        name: a.label,
        shopify_name: a.shopifyName,
        connection_id: a.connectionId,
        connection: a.connectionLabel,
        first_event_at: instant(a.firstEventAt),
        last_event_at: instant(a.lastEventAt),
        last_built_at: instant(a.derivedAt),
      })),
      connections: connections.map((c) => ({
        id: c.id,
        label: c.label,
        demo: c.isDemo,
        paused: c.paused,
        history_from: instant(c.backfillFrom),
        last_sync_at: instant(c.lastOkAt),
        last_attempt_at: instant(c.lastRunAt),
        last_error: c.lastError,
        earnings_readable: earningsReadable(c),
        earnings_error: c.earningsError,
        billing_events_error: c.legacyError,
      })),
    },
    { timeZone, notes }
  )
}

export const listAppsTool = defineTool({
  name: "list_apps",
  title: "List apps",
  description: [
    `Lists the Shopify apps this ${BRAND.name} instance tracks, with the app ids every other tool takes. Call it first.`,
    "Each app has its id, name (shopify_name is Shopify's own name for it), its Partner connection, the first and last event Shopify reported, and last_built_at, when its numbers were last rebuilt from those events.",
    "Each connection (one Shopify Partner organization) has history_from (nothing before it was read), last_sync_at (the last sync that finished without an error), last_attempt_at, last_error, billing_events_error, and earnings_readable: false means its token cannot read Shopify's earnings events, so gross earnings, fees and net earnings are empty for its apps; null means no sync has finished to tell.",
    "Apps hidden in the dashboard are left out. Read the notes: they say when data is demo data, out of date or incomplete.",
  ].join(" "),
  input: z.object({}),
  async run(ctx) {
    const [apps, connections, timeZone] = await Promise.all([ctx.apps(), ctx.read((db) => getConnections(db)), ctx.timeZone()])
    return describeApps(apps, connections, timeZone)
  },
})
