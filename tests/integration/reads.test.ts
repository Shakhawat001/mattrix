import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sumFlows } from "@/lib/analytics/aggregate"
import { getDataHealth } from "@/lib/analytics/data-health"
import { addExcludedShop } from "@/lib/analytics/excluded-shops"
import { getMrrMovers, type MrrMove } from "@/lib/analytics/mrr-movers"
import { getDayRows, listApps } from "@/lib/analytics/queries"
import { addDays, type Range } from "@/lib/analytics/range"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { getShopTimeline } from "@/lib/analytics/shop-timeline"
import type { Database, Queryable } from "@/lib/db/client"
import { apps, connections, syncRuns } from "@/lib/db/schema"
import { generateDemoEvents } from "@/lib/demo/generate"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const NOW = new Date("2026-02-10T12:00:00Z")
const APP_GID = "gid://shopify/App/1"

let counter = 0
function pe(type: string, when: string | number, shop: string | null, over: Partial<ParsedEvent> = {}): ParsedEvent {
  const occurredAt = typeof when === "number" ? new Date(when) : new Date(when.length === 10 ? `${when}T12:00:00Z` : when)
  return {
    id: `evt-${++counter}`,
    occurredAt,
    type,
    appGid: APP_GID,
    appName: "Badge Pro",
    appApiKey: "key-1",
    shop,
    shopGid: shop ? `gid://shopify/Shop/${shop}` : null,
    state: null,
    reason: null,
    reasonDescription: null,
    planHandle: null,
    billingPeriod: null,
    trialDays: null,
    trialDaysRemaining: null,
    cancelEffectiveOn: null,
    amountCents: null,
    currency: "USD",
    grossCents: null,
    netCents: null,
    feeCents: null,
    chargeId: null,
    payload: {},
    ...over,
  }
}
const monthly = (amountCents: number | null, trialDays: number | null = null, planHandle = "pro") => ({ amountCents, trialDays, planHandle, billingPeriod: "EVERY_30_DAYS" })

// The history of tests/integration/pipeline.test.ts.
const history = (): ParsedEvent[] => [
  pe("RELATIONSHIP_INSTALLED", "2026-01-01T10:00:00Z", "a.myshopify.com"),
  pe("SUBSCRIPTION_CREATED", "2026-01-01T11:00:00Z", "a.myshopify.com", monthly(2000, 7)),
  pe("CHARGE_RECURRING", "2026-01-08T11:00:00Z", "a.myshopify.com", { amountCents: 2000 }),
  pe("EARNING_CHARGE_RECURRING", "2026-01-11", "a.myshopify.com", { grossCents: 2000, netCents: 1700, feeCents: 300 }),
  pe("SUBSCRIPTION_UPDATED", "2026-01-20", "a.myshopify.com", monthly(3000)),
  pe("SUBSCRIPTION_CANCELED", "2026-02-05T09:00:00Z", "a.myshopify.com"),
  pe("RELATIONSHIP_UNINSTALLED", "2026-02-05T12:00:00Z", "a.myshopify.com", { reason: "too_expensive", reasonDescription: "Too much for us" }),
  pe("RELATIONSHIP_INSTALLED", "2026-01-02T09:00:00Z", "b.myshopify.com"),
  pe("SUBSCRIPTION_CREATED", "2026-01-02T09:30:00Z", "b.myshopify.com", { amountCents: 24000, billingPeriod: "ANNUAL", trialDays: 7, planHandle: "yearly" }),
  pe("SUBSCRIPTION_CANCELED", "2026-01-05T09:00:00Z", "b.myshopify.com"),
  pe("RELATIONSHIP_UNINSTALLED", "2026-01-05T09:05:00Z", "b.myshopify.com", { reason: "app_not_working, too_expensive" }),
  pe("RELATIONSHIP_INSTALLED", "2026-01-03T09:00:00Z", "c.myshopify.com"),
  pe("RELATIONSHIP_UNINSTALLED", "2026-01-03T15:00:00Z", "c.myshopify.com"),
  pe("RELATIONSHIP_INSTALLED", "2026-01-12", "c.myshopify.com"),
  pe("RELATIONSHIP_UNINSTALLED", "2026-01-04", "d.myshopify.com"),
  pe("RELATIONSHIP_INSTALLED", "2026-01-10", "e.myshopify.com"),
  pe("SUBSCRIPTION_CREATED", "2026-01-10", "e.myshopify.com", monthly(1000, null, "basic")),
  pe("SUBSCRIPTION_FROZEN", "2026-01-15", "e.myshopify.com"),
  pe("SUBSCRIPTION_UNFROZEN", "2026-01-16", "e.myshopify.com"),
]

describe.skipIf(!hasDatabase)("shared reads for pages and agents (Postgres)", () => {
  let database: Database
  let connectionId: string
  let appId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(() => database.close())

  /** A read inside a read-only transaction, the way the MCP server runs every tool. */
  const readOnly = <T>(read: (q: Queryable) => Promise<T>): Promise<T> => database.db.transaction((tx) => read(tx), { accessMode: "read only" })

  async function freshConnection(label = "Test org"): Promise<string> {
    const [c] = await database.db
      .insert(connections)
      .values({ label, partnerId: "42", tokenCiphertext: "secret-ciphertext", tokenHint: "zq9x", backfillFrom: new Date("2025-01-01") })
      .returning({ id: connections.id })
    return c.id
  }

  async function load(list: ParsedEvent[], now = NOW): Promise<void> {
    await insertEvents(database.db, connectionId, list)
    await rebuildStaleApps(database.db, now)
    const [app] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, APP_GID))
    appId = app.id
  }

  async function reset(): Promise<void> {
    await clearAll(database)
    connectionId = await freshConnection()
  }

  describe("one shop's timeline", () => {
    beforeEach(async () => {
      await reset()
      await load(history())
    })

    it("has every stay, period, trial and event of the shop, oldest first", async () => {
      const t = await getShopTimeline(database.db, appId, "a.myshopify.com")
      expect(t).not.toBeNull()
      expect(t!.shop).toBe("a.myshopify.com")
      expect(t!.appId).toBe(appId)
      expect(t!.stays).toEqual([
        { seq: 1, installedAt: new Date("2026-01-01T10:00:00Z"), uninstalledAt: new Date("2026-02-05T12:00:00Z"), reason: "too_expensive", reasonDescription: "Too much for us" },
      ])
      expect(t!.subscriptions).toEqual([
        {
          startedAt: new Date("2026-01-01T11:00:00Z"), endedAt: new Date("2026-01-20T12:00:00Z"), endReason: "replaced", kind: "new", monthlyCents: 2000, previousMonthlyCents: null,
          planHandle: "pro", billingPeriod: "EVERY_30_DAYS", trialEndsAt: new Date("2026-01-08T11:00:00Z"), convertedAt: new Date("2026-01-08T11:00:00Z"),
        },
        {
          startedAt: new Date("2026-01-20T12:00:00Z"), endedAt: new Date("2026-02-05T09:00:00Z"), endReason: "canceled", kind: "change", monthlyCents: 3000, previousMonthlyCents: 2000,
          planHandle: "pro", billingPeriod: "EVERY_30_DAYS", trialEndsAt: null, convertedAt: null,
        },
      ])
      expect(t!.trials).toEqual([
        { startedAt: new Date("2026-01-01T11:00:00Z"), endsAt: new Date("2026-01-08T11:00:00Z"), trialDays: 7, resolvedAt: new Date("2026-01-08T11:00:00Z"), outcome: "converted" },
      ])
      expect(t!.events.map((e) => e.type)).toEqual([
        "RELATIONSHIP_INSTALLED", "SUBSCRIPTION_CREATED", "CHARGE_RECURRING", "EARNING_CHARGE_RECURRING", "SUBSCRIPTION_UPDATED", "SUBSCRIPTION_CANCELED", "RELATIONSHIP_UNINSTALLED",
      ])
      expect(t!.eventCount).toBe(7)
      expect(t!.events[1]).toMatchObject({ planHandle: "pro", billingPeriod: "EVERY_30_DAYS", trialDays: 7, amountCents: 2000, currency: "USD" })
      expect(t!.events[2]).toMatchObject({ amountCents: 2000 })
      expect(t!.events[3]).toMatchObject({ grossCents: 2000, netCents: 1700, feeCents: 300 })
      expect(t!.events[6]).toMatchObject({ reason: "too_expensive", reasonDescription: "Too much for us" })
      // Read through the query builder, so timestamps are real Dates.
      expect(t!.events[0].occurredAt).toBeInstanceOf(Date)
      expect(t!.events[0].occurredAt.toISOString()).toBe("2026-01-01T10:00:00.000Z")
      expect(JSON.stringify(t)).not.toContain("payload")
    })

    it("numbers a shop's returns", async () => {
      const t = await getShopTimeline(database.db, appId, "c.myshopify.com")
      expect(t!.stays.map((s) => [s.seq, s.uninstalledAt === null])).toEqual([[1, false], [2, true]])
      expect(t!.subscriptions).toEqual([])
    })

    it("keeps an uninstall whose install was never seen, with no stay", async () => {
      const t = await getShopTimeline(database.db, appId, "d.myshopify.com")
      expect(t!.events.map((e) => e.type)).toEqual(["RELATIONSHIP_UNINSTALLED"])
      expect(t!.stays).toEqual([])
    })

    it("finds the shop whatever its case or spaces around it", async () => {
      const t = await getShopTimeline(database.db, appId, "  A.MyShopify.COM ")
      expect(t?.shop).toBe("a.myshopify.com")
      expect(t?.eventCount).toBe(7)
    })

    it("is null for a shop the app has no events for", async () => {
      expect(await getShopTimeline(database.db, appId, "nobody.myshopify.com")).toBeNull()
      expect(await getShopTimeline(database.db, appId, "  ")).toBeNull()
      expect(await getShopTimeline(database.db, "00000000-0000-4000-8000-000000000000", "a.myshopify.com")).toBeNull()
    })

    it("keeps each app's shop apart", async () => {
      await insertEvents(database.db, connectionId, [pe("RELATIONSHIP_INSTALLED", "2026-01-15", "a.myshopify.com", { appGid: "gid://shopify/App/2", appName: "Other" })])
      const [other] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, "gid://shopify/App/2"))
      expect((await getShopTimeline(database.db, appId, "a.myshopify.com"))!.eventCount).toBe(7)
      const t = await getShopTimeline(database.db, other.id, "a.myshopify.com")
      expect(t!.events).toHaveLength(1)
      expect(t!.stays).toEqual([]) // not rebuilt yet
    })

    it("keeps the latest events when it caps the list, and says how many there are", async () => {
      const t = await getShopTimeline(database.db, appId, "a.myshopify.com", { maxEvents: 3 })
      expect(t!.events.map((e) => e.type)).toEqual(["SUBSCRIPTION_UPDATED", "SUBSCRIPTION_CANCELED", "RELATIONSHIP_UNINSTALLED"])
      expect(t!.eventCount).toBe(7)
      expect(t!.subscriptions).toHaveLength(2)
    })

    it("orders events on the same instant as the rollup reads them: install, subscription, uninstall", async () => {
      await insertEvents(database.db, connectionId, [
        pe("RELATIONSHIP_UNINSTALLED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-20T10:00:00Z", "x.myshopify.com", monthly(1000)),
        pe("RELATIONSHIP_INSTALLED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
      ])
      const t = await getShopTimeline(database.db, appId, "x.myshopify.com")
      expect(t!.events.map((e) => e.type)).toEqual(["RELATIONSHIP_INSTALLED", "SUBSCRIPTION_CREATED", "RELATIONSHIP_UNINSTALLED"])
    })

    it("reads the same inside a read-only transaction", async () => {
      // The transaction really refuses writes, so a read that wrote anything would fail here.
      await expect(readOnly((tx) => tx.insert(syncRuns).values({ connectionId, trigger: "manual" }))).rejects.toThrow()
      const inside = await readOnly((tx) => getShopTimeline(tx, appId, "a.myshopify.com"))
      expect(inside).toEqual(await getShopTimeline(database.db, appId, "a.myshopify.com"))
    })
  })

  describe("data health", () => {
    // `now` is 10 Feb 2026, so the twelve months run from March 2025 to February 2026.
    const crafted = (): ParsedEvent[] => [
      // a: complete, nothing to flag. Installed in December, so its install counts in that month.
      pe("RELATIONSHIP_INSTALLED", "2025-12-20", "a.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-01", "a.myshopify.com", monthly(2000)),
      pe("CHARGE_RECURRING", "2026-01-08", "a.myshopify.com", { amountCents: 2000 }),
      // b: an uninstall with no install before it, and an uninstall with no shop at all.
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-04", "b.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-04", null),
      // c: a plan with no flat price. d: a free plan, priced at $0 on purpose.
      pe("RELATIONSHIP_INSTALLED", "2026-01-02", "c.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-02", "c.myshopify.com", monthly(null, null, "usage")),
      pe("RELATIONSHIP_INSTALLED", "2026-01-02", "d.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-02", "d.myshopify.com", monthly(0, null, "free")),
      // e: charged every month for a subscription that began before the history.
      pe("CHARGE_RECURRING", "2026-01-15", "e.myshopify.com", { amountCents: 1500 }),
      pe("CHARGE_RECURRING", "2026-02-09", "e.myshopify.com", { amountCents: 1500 }),
      // f: uninstalled twice after one install. g: installed and uninstalled on the same instant.
      pe("RELATIONSHIP_INSTALLED", "2026-01-03", "f.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-04", "f.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-05", "f.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-06T08:00:00Z", "g.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-01-06T08:00:00Z", "g.myshopify.com"),
      // h: a subscription first seen in an update.
      pe("RELATIONSHIP_INSTALLED", "2026-01-07", "h.myshopify.com"),
      pe("SUBSCRIPTION_UPDATED", "2026-02-01", "h.myshopify.com", monthly(1000)),
      // An adjustment with no shop, and an install older than the twelve months.
      pe("EARNING_ADJUSTMENT", "2026-02-02", null, { grossCents: -100, netCents: -100, feeCents: 0 }),
      pe("RELATIONSHIP_INSTALLED", "2024-10-01", "old.myshopify.com"),
    ]

    beforeEach(async () => {
      await reset()
      await load(crafted())
    })

    it("counts events per type and per month, and finds the first and last", async () => {
      const health = await getDataHealth(database.db, [appId], NOW)
      expect(health.months).toEqual([
        "2025-03-01", "2025-04-01", "2025-05-01", "2025-06-01", "2025-07-01", "2025-08-01",
        "2025-09-01", "2025-10-01", "2025-11-01", "2025-12-01", "2026-01-01", "2026-02-01",
      ])
      const [app] = health.apps
      expect(app).toMatchObject({ appId, connectionId, eventCount: 20, dirty: false, rulesOutdated: false })
      expect(app.derivedAt?.toISOString()).toBe(NOW.toISOString())
      expect(app.firstEventAt?.toISOString()).toBe("2024-10-01T12:00:00.000Z")
      expect(app.lastEventAt?.toISOString()).toBe("2026-02-09T12:00:00.000Z")
      expect(app.eventTypes.map((t) => t.type)).toEqual([
        "CHARGE_RECURRING", "EARNING_ADJUSTMENT", "RELATIONSHIP_INSTALLED", "RELATIONSHIP_UNINSTALLED", "SUBSCRIPTION_CREATED", "SUBSCRIPTION_UPDATED",
      ])
      const installed = app.eventTypes.find((t) => t.type === "RELATIONSHIP_INSTALLED")!
      expect(installed.count).toBe(7)
      // The 2024 install is in the count but outside the twelve months.
      expect(installed.perMonth).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 0])
      expect(installed.firstAt.toISOString()).toBe("2024-10-01T12:00:00.000Z")
      expect(app.eventTypes.find((t) => t.type === "CHARGE_RECURRING")!.perMonth.slice(-2)).toEqual([2, 1])
      expect(app.eventTypes.find((t) => t.type === "RELATIONSHIP_UNINSTALLED")).toMatchObject({ count: 5, withoutShop: 1 })
      expect(app.eventTypes.find((t) => t.type === "EARNING_ADJUSTMENT")).toMatchObject({ count: 1, withoutShop: 1 })
    })

    it("finds the gaps a history that starts late leaves", async () => {
      const [app] = (await getDataHealth(database.db, [appId], NOW)).apps
      // b's uninstall and the one with no shop. f's second uninstall follows an install, and g's install comes first on the same instant.
      expect(app.uninstallsWithNoInstall).toBe(2)
      // b and e have events but never an install.
      expect(app.shopsWithNoInstall).toBe(2)
      // h's subscription opened from an update.
      expect(app.subscriptionsWithNoCreation).toBe(1)
      // e is charged but has no subscription, so MRR cannot see it.
      expect(app.chargedShopsWithNoSubscription).toBe(1)
    })

    it("finds subscriptions counted at $0 because no price came, and leaves a real free plan alone", async () => {
      const [app] = (await getDataHealth(database.db, [appId], NOW)).apps
      expect(app.subscriptionsWithNoPrice).toBe(1)
      expect(app.noPricePlans).toEqual([{ planHandle: "usage", count: 1 }])
    })

    it("does not flag an excluded paying shop as charged with no subscription", async () => {
      // a pays and is charged. Once excluded, the rebuild drops its subscription but its charge stays stored.
      await addExcludedShop(database.db, "a.myshopify.com", null)
      await rebuildStaleApps(database.db, NOW)
      const [app] = (await getDataHealth(database.db, [appId], NOW)).apps
      expect(app).toMatchObject({ chargedShopsWithNoSubscription: 1, excludedShops: 1, eventCount: 20 })
    })

    it("leaves excluded shops out of every gap, before and after the rebuild, and counts them instead", async () => {
      for (const shop of ["b.myshopify.com", "c.myshopify.com", "e.myshopify.com", "h.myshopify.com", "nobody.myshopify.com"]) await addExcludedShop(database.db, shop, null)
      // Only the uninstall with no shop is left. The shop with no events here is not counted as excluded.
      const expected = { uninstallsWithNoInstall: 1, shopsWithNoInstall: 0, subscriptionsWithNoCreation: 0, chargedShopsWithNoSubscription: 0, subscriptionsWithNoPrice: 0, noPricePlans: [], excludedShops: 4, eventCount: 20 }
      // Not rebuilt yet: the derived tables still have c's and h's subscriptions.
      expect((await getDataHealth(database.db, [appId], NOW)).apps[0]).toMatchObject({ ...expected, dirty: true })
      await rebuildStaleApps(database.db, NOW)
      const [app] = (await getDataHealth(database.db, [appId], NOW)).apps
      expect(app).toMatchObject({ ...expected, dirty: false })
      expect(app.eventTypes.find((t) => t.type === "CHARGE_RECURRING")!.count).toBe(3)
    })

    it("says when new events wait for a rebuild", async () => {
      await insertEvents(database.db, connectionId, [pe("RELATIONSHIP_INSTALLED", "2026-02-10T01:00:00Z", "z.myshopify.com")])
      const [app] = (await getDataHealth(database.db, [appId], NOW)).apps
      expect(app.dirty).toBe(true)
    })

    it("reports each connection's syncs: the last run, the errors, and the latest five runs", async () => {
      await database.db
        .update(connections)
        .set({
          lastRunAt: new Date("2026-02-10T11:00:00Z"), lastOkAt: new Date("2026-02-09T11:00:00Z"), lastError: "Partner API returned 502", earningsError: "Access denied for earnings",
          legacyError: "Partner API found no app gid://partners/App/1", coreWatermark: new Date("2026-02-09T11:00:00Z"), legacyWatermark: new Date("2026-02-08T11:00:00Z"),
        })
        .where(eq(connections.id, connectionId))
      for (let i = 0; i < 7; i++) {
        const startedAt = new Date(Date.UTC(2026, 1, 3 + i, 11))
        await database.db.insert(syncRuns).values({
          connectionId, trigger: i === 0 ? "startup" : "schedule", startedAt, finishedAt: i === 6 ? null : new Date(startedAt.getTime() + 4000),
          ok: i === 6 ? null : i !== 5, eventsInserted: i, appsFound: 1, error: i === 5 ? "Partner API returned 502" : null, durationMs: i === 6 ? null : 4000,
        })
      }
      const health = await getDataHealth(database.db, [appId], NOW)
      expect(health.connections).toHaveLength(1)
      const [c] = health.connections
      expect(c).toMatchObject({
        connectionId, label: "Test org", isDemo: false, paused: false, apiVersion: "2026-07", lastError: "Partner API returned 502", earningsError: "Access denied for earnings",
        legacyError: "Partner API found no app gid://partners/App/1",
      })
      expect(c.backfillFrom.toISOString()).toBe("2025-01-01T00:00:00.000Z")
      expect(c.coreWatermark?.toISOString()).toBe("2026-02-09T11:00:00.000Z")
      expect(c.earningsWatermark).toBeNull()
      expect(c.legacyWatermark?.toISOString()).toBe("2026-02-08T11:00:00.000Z")
      expect(c.lastRunAt?.toISOString()).toBe("2026-02-10T11:00:00.000Z")
      expect(c.runs.map((r) => r.eventsInserted)).toEqual([6, 5, 4, 3, 2])
      expect(c.runs[0]).toEqual({ trigger: "schedule", startedAt: new Date("2026-02-09T11:00:00Z"), finishedAt: null, ok: null, eventsInserted: 6, appsFound: 1, error: null, durationMs: null })
      expect(c.runs[1]).toMatchObject({ ok: false, error: "Partner API returned 502", durationMs: 4000 })
      expect(c.runs[1].finishedAt?.toISOString()).toBe("2026-02-08T11:00:04.000Z")
      const text = JSON.stringify(health)
      expect(text).not.toContain("secret-ciphertext")
      expect(text).not.toContain("zq9x")
    })

    it("covers only the apps asked for, and the connections they belong to", async () => {
      const otherConnection = await freshConnection("Second org")
      await insertEvents(database.db, otherConnection, [pe("RELATIONSHIP_INSTALLED", "2026-01-15", "q.myshopify.com", { appGid: "gid://shopify/App/2", appName: "Other" })])
      const [other] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, "gid://shopify/App/2"))

      const one = await getDataHealth(database.db, [appId], NOW)
      expect(one.apps.map((a) => a.appId)).toEqual([appId])
      expect(one.connections.map((c) => c.label)).toEqual(["Test org"])

      const both = await getDataHealth(database.db, [other.id, appId, "00000000-0000-4000-8000-000000000000"], NOW)
      expect(both.apps.map((a) => a.appId)).toEqual([other.id, appId])
      // Never built, so not with the current rules either.
      expect(both.apps[0]).toMatchObject({ eventCount: 1, derivedAt: null, dirty: true, rulesOutdated: true, uninstallsWithNoInstall: 0, noPricePlans: [] })
      expect(both.connections.map((c) => c.label)).toEqual(["Test org", "Second org"])

      expect(await getDataHealth(database.db, [], NOW)).toMatchObject({ apps: [], connections: [] })
    })

    it("reads the same inside a read-only transaction", async () => {
      const inside = await readOnly((tx) => getDataHealth(tx, [appId], NOW))
      expect(inside).toEqual(await getDataHealth(database.db, [appId], NOW))
    })
  })

  describe("the shops behind each MRR movement", () => {
    const flowsOf = async (ids: string[], range: Range) => {
      const f = sumFlows(await getDayRows(database.db, ids, range), range)
      return { newMrrCents: f.newMrrCents, expansionMrrCents: f.expansionMrrCents, contractionMrrCents: f.contractionMrrCents, churnedMrrCents: f.churnedMrrCents, newSubs: f.newSubs, canceledSubs: f.canceledSubs }
    }
    const moverTotals = async (ids: string[], range: Range) => {
      const { totals } = await getMrrMovers(database.db, ids, range)
      return { newMrrCents: totals.newMrrCents, expansionMrrCents: totals.expansionMrrCents, contractionMrrCents: totals.contractionMrrCents, churnedMrrCents: totals.churnedMrrCents, newSubs: totals.newSubs, canceledSubs: totals.canceledSubs }
    }

    describe("on a history worked out by hand", () => {
      beforeEach(async () => {
        await reset()
        await load(history())
      })

      it("names each shop, what moved and why", async () => {
        const { moves, totals } = await getMrrMovers(database.db, [appId], { from: "2026-01-01", to: "2026-02-10" })
        expect(moves.map((m) => [m.shop, m.kind, m.date, m.amountCents, m.via ?? m.endReason])).toEqual([
          ["a.myshopify.com", "new", "2026-01-08", 2000, "trial"],
          ["e.myshopify.com", "new", "2026-01-10", 1000, "subscription"],
          ["e.myshopify.com", "churned", "2026-01-15", 1000, "frozen"],
          ["e.myshopify.com", "new", "2026-01-16", 1000, "resume"],
          ["a.myshopify.com", "expansion", "2026-01-20", 1000, null],
          ["a.myshopify.com", "churned", "2026-02-05", 3000, "canceled"],
        ])
        expect(moves[4]).toMatchObject({ appId, before: { planHandle: "pro", billingPeriod: "EVERY_30_DAYS", monthlyCents: 2000 }, after: { planHandle: "pro", billingPeriod: "EVERY_30_DAYS", monthlyCents: 3000 } })
        expect(moves[0].at).toBeInstanceOf(Date)
        expect(moves[0].at.toISOString()).toBe("2026-01-08T11:00:00.000Z")
        expect(totals).toEqual({ newMrrCents: 4000, expansionMrrCents: 1000, contractionMrrCents: 0, churnedMrrCents: 4000, netNewMrrCents: 1000, newSubs: 3, canceledSubs: 2 })
      })

      it("keeps to the range, and agrees with the rollup on it", async () => {
        const range = { from: "2026-01-20", to: "2026-02-10" }
        const { moves, totals } = await getMrrMovers(database.db, [appId], range)
        expect(moves.map((m) => [m.shop, m.kind, m.amountCents])).toEqual([
          ["a.myshopify.com", "expansion", 1000],
          ["a.myshopify.com", "churned", 3000],
        ])
        expect(totals).toMatchObject({ expansionMrrCents: 1000, churnedMrrCents: 3000, netNewMrrCents: -2000 })
        expect(await moverTotals([appId], range)).toEqual(await flowsOf([appId], range))
      })

      it("returns nothing for no apps, or a range with no moves", async () => {
        expect(await getMrrMovers(database.db, [], { from: "2026-01-01", to: "2026-02-10" })).toMatchObject({ moves: [], totals: { newMrrCents: 0, newSubs: 0 } })
        expect((await getMrrMovers(database.db, [appId], { from: "2026-01-21", to: "2026-02-04" })).moves).toEqual([])
      })

      it("reads the same inside a read-only transaction", async () => {
        const range = { from: "2026-01-01", to: "2026-02-10" }
        const inside = await readOnly((tx) => getMrrMovers(tx, [appId], range))
        expect(inside).toEqual(await getMrrMovers(database.db, [appId], range))
      })
    })

    describe("on demo data", () => {
      const now = new Date("2026-06-15T12:00:00Z")
      const today = "2026-06-15"
      const at = (days: number, hour = 12) => Date.UTC(2026, 5, 15 + days, hour)
      const EDGE = "gid://shopify/App/77"
      const edge = (type: string, when: number, shop: string, over: Partial<ParsedEvent> = {}) => pe(type, when, shop, { appGid: EDGE, appName: "Edge cases", ...over })
      let ids: string[]

      // What demo data does not do: downgrades, free plans, freezes, cancels that take effect
      // later, plan changes sent as two events, and events dated after the rebuild.
      const edgeCases = (): ParsedEvent[] => [
        edge("SUBSCRIPTION_CREATED", at(-60), "s1.myshopify.com", monthly(3000, null, "plus")),
        edge("SUBSCRIPTION_UPDATED", at(-40), "s1.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CREATED", at(-55), "s2.myshopify.com", monthly(2000)),
        edge("SUBSCRIPTION_UPDATED", at(-35), "s2.myshopify.com", monthly(0, null, "free")),
        edge("SUBSCRIPTION_UPDATED", at(-20), "s2.myshopify.com", monthly(2000)),
        edge("SUBSCRIPTION_CREATED", at(-50), "s3.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_FROZEN", at(-30), "s3.myshopify.com"),
        edge("SUBSCRIPTION_UNFROZEN", at(-25), "s3.myshopify.com"),
        edge("SUBSCRIPTION_CREATED", at(-45), "s4.myshopify.com", monthly(2000)),
        edge("SUBSCRIPTION_CANCELLATION_SCHEDULED", at(-20), "s4.myshopify.com", { cancelEffectiveOn: new Date(at(-10, 0)) }),
        edge("SUBSCRIPTION_CREATED", at(-44), "s5.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CREATED", at(-15), "s5.myshopify.com", monthly(3000, null, "plus")),
        edge("SUBSCRIPTION_CANCELED", at(-15) + 60_000, "s5.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CREATED", at(-43), "s6.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CANCELED", at(-12), "s6.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CREATED", at(-12) + 4 * 60_000, "s6.myshopify.com", monthly(2500, null, "plus")),
        edge("SUBSCRIPTION_CREATED", at(-42), "s7.myshopify.com", monthly(2000)),
        edge("SUBSCRIPTION_CANCELED", at(3), "s7.myshopify.com"),
        edge("SUBSCRIPTION_CREATED", at(2), "s8.myshopify.com", monthly(1500)),
        edge("SUBSCRIPTION_CREATED", at(-30), "s9.myshopify.com", monthly(2000, 7)),
        edge("SUBSCRIPTION_CREATED", at(-41), "s10.myshopify.com", monthly(1000, null, "basic")),
        edge("SUBSCRIPTION_CREATED", at(-8), "s10.myshopify.com", monthly(2000, null, "pro")),
        edge("SUBSCRIPTION_CREATED", at(-8), "s10.myshopify.com", monthly(3000, null, "plus")),
        edge("RELATIONSHIP_INSTALLED", at(-40), "s11.myshopify.com"),
        edge("SUBSCRIPTION_CREATED", at(-40), "s11.myshopify.com", { ...monthly(24000, null, "yearly"), billingPeriod: "ANNUAL" }),
        edge("RELATIONSHIP_UNINSTALLED", at(-5), "s11.myshopify.com"),
      ]

      beforeAll(async () => {
        await reset()
        const demo = generateDemoEvents({ now, days: 200, seed: 11 }).events
        await insertEvents(database.db, connectionId, [...demo, ...edgeCases()])
        await rebuildStaleApps(database.db, now)
        ids = (await listApps(database.db)).map((a) => a.id)
      })

      it("has every kind of move to add up", async () => {
        expect(ids).toHaveLength(4)
        const { moves } = await getMrrMovers(database.db, ids, { from: "2025-11-01", to: today })
        const kinds = new Set(moves.map((m: MrrMove) => (m.kind === "new" ? `new ${m.via}` : m.kind === "churned" ? `churned ${m.endReason}` : m.kind)))
        for (const kind of ["new subscription", "new trial", "new resume", "new plan_change", "expansion", "contraction", "churned canceled", "churned uninstalled", "churned frozen", "churned replaced"]) {
          expect(kinds.has(kind), kind).toBe(true)
        }
        expect(moves.length).toBeGreaterThan(100)
      })

      it("adds up to the rollup's flows for every app, all apps together, and every range tried", async () => {
        const ranges: Range[] = [
          { from: "2025-11-01", to: today }, // all of it
          { from: addDays(today, -29), to: today },
          { from: addDays(today, -6), to: today },
          { from: today, to: today },
          { from: "2026-03-01", to: "2026-03-31" },
          { from: "2026-04-15", to: "2026-05-14" },
          { from: "2026-01-01", to: addDays(today, -1) }, // ends the day before the last rebuild
          { from: addDays(today, -10), to: addDays(today, -10) }, // s4's cancel takes effect
          { from: addDays(today, -15), to: addDays(today, -15) }, // s5's upgrade
          { from: addDays(today, -40), to: addDays(today, -35) },
        ]
        // A week at a time across the whole history, so every day is in some range.
        for (let from = "2025-11-24"; from <= today; from = addDays(from, 7)) ranges.push({ from, to: addDays(from, 6) > today ? today : addDays(from, 6) })

        for (const range of ranges) {
          for (const scope of [ids, ...ids.map((id) => [id])]) {
            expect(await moverTotals(scope, range), `${range.from} to ${range.to}, ${scope.length} apps`).toEqual(await flowsOf(scope, range))
          }
        }
      })

      it("dates each move on the day the rollup counts it, on every day", async () => {
        for (const id of ids) {
          const range = { from: "2025-11-01", to: today }
          const { moves } = await getMrrMovers(database.db, [id], range)
          const rows = await getDayRows(database.db, [id], range)
          for (const row of rows.filter((r) => r.date >= range.from)) {
            const day = moves.filter((m) => m.date === row.date)
            const sum = (kind: MrrMove["kind"]) => day.filter((m) => m.kind === kind).reduce((s, m) => s + m.amountCents, 0)
            expect(
              [sum("new"), sum("expansion"), sum("contraction"), sum("churned"), day.filter((m) => m.kind === "new").length, day.filter((m) => m.kind === "churned").length],
              `${id} ${row.date}`,
            ).toEqual([row.newMrrCents, row.expansionMrrCents, row.contractionMrrCents, row.churnedMrrCents, row.newSubs, row.canceledSubs])
          }
        }
      })

      it("counts moves dated after the rebuild on its last day, as the rollup does", async () => {
        const [edgeApp] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, EDGE))
        const last = await getMrrMovers(database.db, [edgeApp.id], { from: today, to: today })
        expect(last.moves.map((m) => [m.shop, m.kind, m.amountCents])).toEqual([
          ["s8.myshopify.com", "new", 1500],
          ["s7.myshopify.com", "churned", 2000],
        ])
        expect(last.moves.every((m) => m.at.getTime() > now.getTime())).toBe(true)
        expect((await getMrrMovers(database.db, [edgeApp.id], { from: addDays(today, -7), to: addDays(today, -1) })).moves.some((m) => m.shop === "s7.myshopify.com")).toBe(false)
      })

      it("explains a downgrade, a move to a free plan, a freeze and an upgrade sent as two events", async () => {
        const [edgeApp] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, EDGE))
        const { moves } = await getMrrMovers(database.db, [edgeApp.id], { from: "2026-01-01", to: today })
        const of = (shop: string) => moves.filter((m) => m.shop === shop).map((m) => [m.kind, m.amountCents, m.via ?? m.endReason ?? null])
        expect(of("s1.myshopify.com")).toEqual([["new", 3000, "subscription"], ["contraction", 2000, null]])
        expect(of("s2.myshopify.com")).toEqual([["new", 2000, "subscription"], ["churned", 2000, "replaced"], ["new", 2000, "plan_change"]])
        expect(of("s3.myshopify.com")).toEqual([["new", 1000, "subscription"], ["churned", 1000, "frozen"], ["new", 1000, "resume"]])
        expect(of("s4.myshopify.com")).toEqual([["new", 2000, "subscription"], ["churned", 2000, "canceled"]])
        expect(of("s5.myshopify.com")).toEqual([["new", 1000, "subscription"], ["expansion", 2000, null]])
        expect(of("s6.myshopify.com")).toEqual([["new", 1000, "subscription"], ["expansion", 1500, null]])
        expect(of("s9.myshopify.com")).toEqual([["new", 2000, "trial"]])
        // Two plan changes on one instant: the middle plan never paid, so the rollup books churn and new revenue.
        // Which of the two plans was last is up to the order the database returns same-instant events in.
        expect(of("s10.myshopify.com")).toEqual([["new", 1000, "subscription"], ["churned", 1000, "replaced"], ["new", expect.any(Number), "plan_change"]])
        expect(of("s11.myshopify.com")).toEqual([["new", 2000, "subscription"], ["churned", 2000, "uninstalled"]])
        const s4 = moves.find((m) => m.shop === "s4.myshopify.com" && m.kind === "churned")!
        expect(s4.date).toBe(addDays(today, -10))
      })
    })
  })
})
