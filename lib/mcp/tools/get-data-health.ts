import { z } from "zod"
import { getDataHealth } from "@/lib/analytics/data-health"
import { listApps } from "@/lib/analytics/queries"
import { count, envelope, instant } from "../output"
import { APPS_INPUT, sourceNotes } from "../scope"
import { defineTool } from "../tool"

export const getDataHealthTool = defineTool({
  name: "get_data_health",
  title: "Data health",
  description: [
    "How complete the stored data is, to read before trusting a surprising number. Per app: the events stored by type and by month for the last 12 months, the first and last event, the signs of a history that starts after the shops did (uninstalls and shops with no install, subscriptions first seen in an update, paying shops with no subscription), subscriptions counted at $0 because Shopify sent no price, excluded shops, and whether a rebuild is pending.",
    "Per connection: how far each sync pass has read, the last sync and its error, and the latest five sync runs.",
    "Covers the chosen apps (default: every app that is not hidden) and says how many apps are hidden.",
  ].join(" "),
  input: z.object({ ...APPS_INPUT }),
  async run(ctx, input) {
    const apps = await ctx.apps(input.app_ids)
    const appIds = apps.map((a) => a.id)
    const timeZone = await ctx.timeZone()
    const [health, all] = await ctx.read((db) => Promise.all([getDataHealth(db, appIds, timeZone, ctx.now), listApps(db)]))
    const hidden = all.filter((a) => a.hidden).length
    const nameOf = new Map(apps.map((a) => [a.id, a.label]))

    const notes = await sourceNotes(ctx, apps)
    if (hidden > 0) notes.push(`${hidden} ${hidden === 1 ? "app is" : "apps are"} hidden in Settings and left out, as on the dashboard.`)
    notes.push("Event counts include excluded shops, as stored. The gap checks leave them out, since no number counts them.", "per_month counts events in each month of months, oldest first; months are months in the dashboard's time zone, the timezone of this answer.")

    return envelope(
      {
        hidden_apps: count(hidden),
        months: health.months,
        apps: health.apps.map((a) => ({
          id: a.appId,
          name: nameOf.get(a.appId) ?? null,
          connection_id: a.connectionId,
          first_event_at: instant(a.firstEventAt),
          last_event_at: instant(a.lastEventAt),
          events: count(a.eventCount),
          event_types: a.eventTypes.map((t) => ({
            type: t.type,
            events: count(t.count),
            without_shop: count(t.withoutShop),
            first_at: instant(t.firstAt),
            last_at: instant(t.lastAt),
            per_month: t.perMonth,
          })),
          uninstalls_with_no_install: count(a.uninstallsWithNoInstall),
          shops_with_no_install: count(a.shopsWithNoInstall),
          subscriptions_with_no_creation: count(a.subscriptionsWithNoCreation),
          charged_shops_with_no_subscription: count(a.chargedShopsWithNoSubscription),
          subscriptions_with_no_price: count(a.subscriptionsWithNoPrice),
          no_price_plans: a.noPricePlans.map((p) => ({ plan: p.planHandle, subscriptions: count(p.count) })),
          excluded_shops: count(a.excludedShops),
          last_built_at: instant(a.derivedAt),
          rebuild_pending: a.dirty,
          built_with_older_rules: a.rulesOutdated,
        })),
        connections: health.connections.map((c) => ({
          id: c.connectionId,
          label: c.label,
          demo: c.isDemo,
          paused: c.paused,
          api_version: c.apiVersion,
          history_from: instant(c.backfillFrom),
          read_up_to: { core: instant(c.coreWatermark), earnings: instant(c.earningsWatermark), payout_records: instant(c.transactionsWatermark), billing_screen: instant(c.legacyWatermark) },
          sync_requested_at: instant(c.syncRequestedAt),
          last_attempt_at: instant(c.lastRunAt),
          last_sync_at: instant(c.lastOkAt),
          last_error: c.lastError,
          earnings_error: c.earningsError,
          payout_records_error: c.transactionsError,
          billing_events_error: c.legacyError,
          runs: c.runs.map((r) => ({
            trigger: r.trigger,
            started_at: instant(r.startedAt),
            finished_at: instant(r.finishedAt),
            ok: r.ok,
            events_inserted: count(r.eventsInserted),
            apps_found: count(r.appsFound),
            error: r.error,
            duration_ms: r.durationMs,
          })),
        })),
      },
      { timeZone, notes }
    )
  },
})
