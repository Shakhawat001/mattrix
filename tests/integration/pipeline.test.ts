import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { kpisFor, stocksAt } from "@/lib/analytics/aggregate"
import {
  getDayRows,
  getExplanations,
  getLifetimeStats,
  getPlanMix,
  getReasons,
  getRetention,
  getStays,
  getTrialStats,
  listApps,
  listEventTypes,
  listEvents,
  listShops,
  getConnections,
  earliestDate,
} from "@/lib/analytics/queries"
import { cohortRetention } from "@/lib/analytics/aggregate"
import { DERIVE_VERSION } from "@/lib/analytics/derive"
import { rebuildApp, rebuildStaleApps } from "@/lib/analytics/rebuild"
import type { Database } from "@/lib/db/client"
import { apps, connections, dailyMetrics, events, installs, subscriptions, syncRuns, trials } from "@/lib/db/schema"
import { generateDemoEvents } from "@/lib/demo/generate"
import { createPartnerClient } from "@/lib/partner/client"
import type { ParsedEvent } from "@/lib/partner/parse"
import { createDbSyncStore, insertEvents } from "@/lib/partner/store"
import { syncConnection } from "@/lib/partner/sync"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const NOW = new Date("2026-02-10T12:00:00Z")
const APP_GID = "gid://shopify/App/1"

function pe(type: string, when: string, shop: string | null, over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    id: `evt-${type}-${when}-${shop}-${Math.random().toString(36).slice(2, 8)}`,
    occurredAt: new Date(when.length === 10 ? `${when}T12:00:00Z` : when),
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
const monthly = (amountCents: number, trialDays: number | null = null, planHandle = "pro") => ({ amountCents, trialDays, planHandle, billingPeriod: "EVERY_30_DAYS" })

// The same history as test/derive.test.ts, so the two can be read side by side.
const history: ParsedEvent[] = [
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

describe.skipIf(!hasDatabase)("events to numbers (Postgres)", () => {
  let database: Database
  let connectionId: string
  let appId: string

  beforeAll(async () => {
    database = await openTestDatabase()
  })
  afterAll(() => database.close())

  beforeEach(async () => {
    await clearAll(database)
    const [c] = await database.db
      .insert(connections)
      .values({ label: "Test org", partnerId: "42", tokenCiphertext: "x", tokenHint: "abcd", backfillFrom: new Date("2025-01-01") })
      .returning({ id: connections.id })
    connectionId = c.id
  })

  async function load(list: ParsedEvent[] = history) {
    await insertEvents(database.db, connectionId, list)
    await rebuildStaleApps(database.db, NOW)
    const [app] = await database.db.select({ id: apps.id }).from(apps)
    appId = app.id
  }

  describe("storing events", () => {
    it("creates the app from its first event, with the name Shopify gave it", async () => {
      await load()
      const [app] = await database.db.select().from(apps)
      expect(app).toMatchObject({ gid: APP_GID, name: "Badge Pro", apiKey: "key-1", connectionId })
      expect(app.firstEventAt?.toISOString()).toBe("2026-01-01T10:00:00.000Z")
    })

    it("stores an event once, however many times it is read", async () => {
      const first = await insertEvents(database.db, connectionId, history)
      const again = await insertEvents(database.db, connectionId, history)
      expect(first.inserted).toBe(history.length)
      expect(again.inserted).toBe(0)
      expect(await database.db.select().from(events)).toHaveLength(history.length)
    })

    it("marks an app dirty when it gains events, and clears that on rebuild", async () => {
      await insertEvents(database.db, connectionId, history)
      const [dirty] = await database.db.select({ dirty: apps.dirty }).from(apps)
      expect(dirty.dirty).toBe(true)
      await rebuildStaleApps(database.db, NOW)
      const [clean] = await database.db.select({ dirty: apps.dirty, derivedAt: apps.derivedAt }).from(apps)
      expect(clean.dirty).toBe(false)
      expect(clean.derivedAt?.toISOString()).toBe(NOW.toISOString())
      // Nothing new: nothing is rebuilt.
      await insertEvents(database.db, connectionId, history)
      expect(await rebuildStaleApps(database.db, NOW)).toBe(0)
    })

    it("rebuilds an app that was last built before today", async () => {
      await load()
      expect(await rebuildStaleApps(database.db, new Date("2026-02-11T01:00:00Z"))).toBe(1)
      const rows = await database.db.select().from(dailyMetrics).where(eq(dailyMetrics.date, "2026-02-11"))
      expect(rows).toHaveLength(1)
    })

    it("rebuilds an app built with an older version of the rules, and leaves a newer one alone", async () => {
      await load()
      const version = async () => (await database.db.select({ v: apps.deriveVersion }).from(apps))[0].v
      expect(await version()).toBe(DERIVE_VERSION)
      expect(await rebuildStaleApps(database.db, NOW)).toBe(0)

      // As after a deploy that changed a rule: the rows on file came from the old one.
      await database.db.update(apps).set({ deriveVersion: DERIVE_VERSION - 1 })
      await database.db.delete(dailyMetrics)
      expect(await rebuildStaleApps(database.db, NOW)).toBe(1)
      expect(await version()).toBe(DERIVE_VERSION)
      expect(await database.db.select().from(dailyMetrics)).toHaveLength(41)

      // Written by a newer deploy still running alongside this one.
      await database.db.update(apps).set({ deriveVersion: DERIVE_VERSION + 1 })
      expect(await rebuildStaleApps(database.db, NOW)).toBe(0)
    })

    it("keeps a real app name once it has one, and fills a missing key later", async () => {
      await insertEvents(database.db, connectionId, [pe("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com", { appName: null, appApiKey: null })])
      let [app] = await database.db.select().from(apps)
      expect(app.name).toBe(APP_GID)
      await insertEvents(database.db, connectionId, [pe("RELATIONSHIP_INSTALLED", "2026-01-02", "y.myshopify.com")])
      ;[app] = await database.db.select().from(apps)
      expect(app).toMatchObject({ name: "Badge Pro", apiKey: "key-1" })
      await insertEvents(database.db, connectionId, [pe("RELATIONSHIP_INSTALLED", "2026-01-03", "z.myshopify.com", { appName: null, appApiKey: null })])
      ;[app] = await database.db.select().from(apps)
      expect(app.name).toBe("Badge Pro")
    })

    it("files events of different apps under different apps", async () => {
      await insertEvents(database.db, connectionId, [
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "a.myshopify.com"),
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "b.myshopify.com", { appGid: "gid://shopify/App/2", appName: "Other App" }),
      ])
      expect((await listApps(database.db)).map((a) => a.label).sort()).toEqual(["Badge Pro", "Other App"])
    })

    it("stores more events than one statement can carry", async () => {
      const many = Array.from({ length: 1200 }, (_, i) => pe("RELATIONSHIP_INSTALLED", "2026-01-05", `shop-${i}.myshopify.com`))
      expect((await insertEvents(database.db, connectionId, many)).inserted).toBe(1200)
    })
  })

  describe("derived tables", () => {
    it("writes one stay per install, with the reason on the one that ended", async () => {
      await load()
      const rows = await database.db.select().from(installs).orderBy(installs.installedAt)
      expect(rows).toHaveLength(5)
      expect(rows.find((r) => r.shop === "a.myshopify.com")).toMatchObject({ reason: "too_expensive", reasonDescription: "Too much for us" })
    })

    it("writes subscription periods and trials", async () => {
      await load()
      expect(await database.db.select().from(subscriptions)).toHaveLength(5)
      const t = await database.db.select().from(trials)
      expect(t.map((x) => x.outcome).sort()).toEqual(["canceled", "converted"])
    })

    it("replaces the old rows on a rebuild rather than adding to them", async () => {
      await load()
      await rebuildApp(database.db, appId, NOW)
      await rebuildApp(database.db, appId, NOW)
      expect(await database.db.select().from(installs)).toHaveLength(5)
      expect(await database.db.select().from(dailyMetrics)).toHaveLength(41)
    })

    it("derives the same rows however events at the same instant are stored", async () => {
      // One plan change Shopify reports as two events at the same instant. Read in one order it is
      // an upgrade; in the other, a cancel and a new sale. Every rebuild must read them alike.
      const base = [
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-01", "x.myshopify.com", monthly(1000, null, "basic")),
      ]
      const created = pe("SUBSCRIPTION_CREATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus"))
      const updated = pe("SUBSCRIPTION_UPDATED", "2026-01-10T10:00:00Z", "x.myshopify.com", monthly(3000, null, "plus"))
      const derivedFrom = async (stored: ParsedEvent[]) => {
        await database.db.delete(events)
        await load(stored)
        const periods = (await database.db.select().from(subscriptions)).map((p) => JSON.stringify({ ...p, id: undefined })).sort()
        return { periods, days: await database.db.select().from(dailyMetrics).orderBy(dailyMetrics.date) }
      }

      const first = await derivedFrom([...base, created, updated])
      const second = await derivedFrom([...base, updated, created])
      expect(second).toEqual(first)
    })

    it("deletes everything under a connection with it", async () => {
      await load()
      await database.db.delete(connections).where(eq(connections.id, connectionId))
      for (const table of [apps, events, installs, subscriptions, trials, dailyMetrics]) {
        expect(await database.db.select().from(table)).toHaveLength(0)
      }
    })
  })

  describe("numbers for a range", () => {
    const range = { from: "2026-01-01", to: "2026-02-10" }

    it("adds up the whole history", async () => {
      await load()
      const k = kpisFor(await getDayRows(database.db, [appId], range), range)
      expect(k).toMatchObject({ installs: 5, reinstalls: 1, uninstalls: 4, activeInstalls: 2, activeSubs: 1, mrr: 1000, trialSubs: 0, trialMrr: 0 })
      expect(k.charged).toBe(2000)
      expect(k.trialsStarted).toBe(2)
      expect(k.trialsConverted).toBe(1)
      expect(k.trialsCanceled).toBe(1)
      expect(k.trialConversion).toBeCloseTo(0.5)
    })

    it("takes the starting stock from before the range", async () => {
      await load()
      const jan20 = { from: "2026-01-20", to: "2026-02-10" }
      const rows = await getDayRows(database.db, [appId], jan20)
      const k = kpisFor(rows, jan20)
      expect(k.mrrStart).toBe(3000) // a at $20 and e at $10 on the 19th... a was $20, e $10: 3000
      expect(k.expansionMrr).toBe(1000)
      expect(k.churnedMrr).toBe(3000)
      expect(k.mrr).toBe(1000)
      expect(stocksAt(rows, "2026-02-04").mrrCents).toBe(4000)
    })

    it("finds the first day with data", async () => {
      await load()
      expect(await earliestDate(database.db, [appId])).toBe("2026-01-01")
      expect(await earliestDate(database.db, [])).toBeNull()
    })

    it("returns nothing for no apps instead of everything", async () => {
      await load()
      expect(await getDayRows(database.db, [], range)).toEqual([])
      expect(await getReasons(database.db, [], range)).toEqual([])
      expect((await listShops(database.db, [])).rows).toEqual([])
      expect((await listEvents(database.db, [])).total).toBe(0)
    })
  })

  describe("what became of the starting shops", () => {
    const retentionFor = async (range: { from: string; to: string }) => (await getRetention(database.db, [appId], range)).get(appId)

    it("follows the shops that were there on the first day to the last", async () => {
      await load()
      // At the start of 20 January: a, c (back since the 12th) and e have the app; a pays $20 and e pays $10.
      // By the end of 10 February: a is gone (canceled and uninstalled on the 5th) and e still pays $10.
      expect(await retentionFor({ from: "2026-01-20", to: "2026-02-10" })).toEqual({
        startInstalls: 3, keptInstalls: 2, startSubs: 2, keptSubs: 1, startMrr: 3000, endMrr: 1000, keptMrr: 1000,
      })
    })

    it("gives net retention credit for an upgrade, and gross retention none", async () => {
      await load()
      // At the start of 9 January only a is there, paying $20 since its trial converted on the 8th.
      // On the 20th a moved to $30 and stayed through the end of January.
      const r = await retentionFor({ from: "2026-01-09", to: "2026-01-31" })
      expect(r).toEqual({ startInstalls: 1, keptInstalls: 1, startSubs: 1, keptSubs: 1, startMrr: 2000, endMrr: 3000, keptMrr: 2000 })
      expect(r!.endMrr / r!.startMrr).toBeCloseTo(1.5) // net retention
      expect(r!.keptMrr / r!.startMrr).toBe(1) // gross retention
    })

    it("has nothing for a range that starts before anyone was there", async () => {
      await load()
      expect((await getRetention(database.db, [appId], { from: "2026-01-01", to: "2026-02-10" })).has(appId)).toBe(false)
    })

    it("does not count shops that joined during the range", async () => {
      await load()
      // Nobody is there at the start of 2 January except a, so b (installed on the 2nd) is not in the starting group.
      // a is installed but still in its free trial, so it is not a paying subscriber yet.
      const r = await retentionFor({ from: "2026-01-02", to: "2026-02-10" })
      expect(r!.startInstalls).toBe(1)
      expect(r!.startSubs).toBe(0)
    })

    it("counts a shop that left and came back inside the range as kept", async () => {
      await load([
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "x.myshopify.com"),
        pe("RELATIONSHIP_UNINSTALLED", "2026-01-10", "x.myshopify.com"),
        pe("RELATIONSHIP_INSTALLED", "2026-01-15", "x.myshopify.com"),
      ])
      expect(await retentionFor({ from: "2026-01-05", to: "2026-01-20" })).toMatchObject({ startInstalls: 1, keptInstalls: 1 })
      // Over a range that ends while the shop is gone, it is lost.
      expect(await retentionFor({ from: "2026-01-05", to: "2026-01-12" })).toMatchObject({ startInstalls: 1, keptInstalls: 0 })
    })

    it("treats a move to a free plan as a lost subscriber", async () => {
      await load([
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "y.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-01", "y.myshopify.com", monthly(2000)),
        pe("SUBSCRIPTION_UPDATED", "2026-01-10", "y.myshopify.com", { amountCents: 0, planHandle: "free", billingPeriod: "EVERY_30_DAYS", trialDays: null }),
      ])
      expect(await retentionFor({ from: "2026-01-05", to: "2026-01-31" })).toMatchObject({ startSubs: 1, keptSubs: 0, startMrr: 2000, endMrr: 0, keptMrr: 0 })
    })

    it("returns nothing at all for no apps", async () => {
      expect((await getRetention(database.db, [], { from: "2026-01-01", to: "2026-01-31" })).size).toBe(0)
    })
  })

  describe("churn, retention and plans", () => {
    const range = { from: "2026-01-01", to: "2026-02-10" }

    it("counts uninstall reasons, splitting a list and ranking by count", async () => {
      await load()
      const reasons = await getReasons(database.db, [appId], range)
      expect(reasons.find((r) => r.reason === "too_expensive")?.count).toBe(2)
      expect(reasons.find((r) => r.reason === "app_not_working")?.count).toBe(1)
      expect(reasons.find((r) => r.reason === "No reason given")?.count).toBe(1)
      expect(reasons[0].reason).toBe("too_expensive")
    })

    it("limits reasons to the range", async () => {
      await load()
      const january = await getReasons(database.db, [appId], { from: "2026-01-01", to: "2026-01-31" })
      expect(january.find((r) => r.reason === "too_expensive")?.count).toBe(1)
    })

    it("lists what merchants wrote, with the shop, newest first", async () => {
      await load()
      const words = await getExplanations(database.db, [appId], range)
      expect(words).toHaveLength(1)
      expect(words[0]).toMatchObject({ shop: "a.myshopify.com", reason: "too_expensive", text: "Too much for us" })
    })

    it("measures how long installs lasted", async () => {
      await load()
      const stats = await getLifetimeStats(database.db, [appId], range)
      expect(stats.ended).toBe(3)
      expect(stats.open).toBe(2)
      expect(stats.within1Day).toBe(1) // c, the same day
      expect(stats.within7Days).toBe(2) // c and b
      expect(stats.medianDays).toBeCloseTo(3.0, 1) // b: 3 days, c: 0.25, a: 35
    })

    it("feeds cohort retention from the installs of a range", async () => {
      await load()
      const stays = await getStays(database.db, [appId], range)
      expect(stays).toHaveLength(5)
      const cohorts = cohortRetention(stays, "week", NOW)
      expect(cohorts[0].cohort).toBe("2025-12-29")
      expect(cohorts[0].size).toBe(3) // a, b, c on 1 to 3 January
    })

    it("shows who pays for which plan at the end of a day, yearly plans at their monthly value, trials left out", async () => {
      await load([
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "m.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-01", "m.myshopify.com", monthly(2000)),
        pe("RELATIONSHIP_INSTALLED", "2026-01-01", "y.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-01", "y.myshopify.com", { amountCents: 24000, billingPeriod: "ANNUAL", planHandle: "yearly" }),
        pe("RELATIONSHIP_INSTALLED", "2026-01-02", "t.myshopify.com"),
        pe("SUBSCRIPTION_CREATED", "2026-01-02", "t.myshopify.com", monthly(5000, 14, "max")),
      ])
      expect(await getPlanMix(database.db, [appId], "2026-01-05")).toEqual([
        { planHandle: "pro", billingPeriod: "Monthly", subscribers: 1, mrrCents: 2000 },
        { planHandle: "yearly", billingPeriod: "Yearly", subscribers: 1, mrrCents: 2000 },
      ])
      // t's trial ends on 16 January and it starts paying.
      expect((await getPlanMix(database.db, [appId], "2026-01-20"))[0]).toEqual({ planHandle: "max", billingPeriod: "Monthly", subscribers: 1, mrrCents: 5000 })
    })

    it("shows the plans of the whole history at its end", async () => {
      await load()
      expect(await getPlanMix(database.db, [appId], "2026-01-09")).toEqual([{ planHandle: "pro", billingPeriod: "Monthly", subscribers: 1, mrrCents: 2000 }])
      expect(await getPlanMix(database.db, [appId], "2026-02-10")).toEqual([{ planHandle: "basic", billingPeriod: "Monthly", subscribers: 1, mrrCents: 1000 }])
    })

    it("reports what became of trials, and how long converting took", async () => {
      await load()
      const stats = await getTrialStats(database.db, [appId], range)
      expect(stats).toMatchObject({ started: 2, converted: 1, canceled: 1, open: 0 })
      expect(stats.medianDaysToConvert).toBeCloseTo(7, 1)
    })
  })

  describe("shops", () => {
    it("lists every shop once with where it stands", async () => {
      await load()
      const { rows, total } = await listShops(database.db, [appId], { sort: "shop" })
      expect(total).toBe(4)
      expect(rows.map((r) => r.shop)).toEqual(["a.myshopify.com", "b.myshopify.com", "c.myshopify.com", "e.myshopify.com"])
      const c = rows.find((r) => r.shop === "c.myshopify.com")!
      expect(c).toMatchObject({ installed: true, installs: 2 })
      const a = rows.find((r) => r.shop === "a.myshopify.com")!
      expect(a).toMatchObject({ installed: false, subscribed: false, charged: 2000, reason: "too_expensive" })
      // Raw SQL returns timestamps as text; the rows must carry real Dates the pages can format.
      expect(a.firstInstalledAt).toBeInstanceOf(Date)
      expect(a.firstInstalledAt.toISOString()).toBe("2026-01-01T10:00:00.000Z")
      expect(a.lastInstalledAt).toBeInstanceOf(Date)
      expect(a.uninstalledAt?.toISOString()).toBe("2026-02-05T12:00:00.000Z")
      expect(c.uninstalledAt).toBeNull()
    })

    it("filters by status and by plan", async () => {
      await load()
      const shops = async (f: Parameters<typeof listShops>[2]) => (await listShops(database.db, [appId], { ...f, sort: "shop" })).rows.map((r) => r.shop)
      expect(await shops({ status: "installed" })).toEqual(["c.myshopify.com", "e.myshopify.com"])
      expect(await shops({ status: "uninstalled" })).toEqual(["a.myshopify.com", "b.myshopify.com"])
      expect(await shops({ plan: "paying" })).toEqual(["e.myshopify.com"])
      expect(await shops({ plan: "free" })).toEqual(["c.myshopify.com"])
      // b canceled inside its trial and never paid, so it never was a paying customer to lose.
      expect(await shops({ plan: "churned" })).toEqual(["a.myshopify.com"])
      expect(await shops({ plan: "trial" })).toEqual([])
    })

    it("searches by name, taking % and _ literally", async () => {
      await load()
      expect((await listShops(database.db, [appId], { q: "A.MYSHOPIFY" })).rows.map((r) => r.shop)).toEqual(["a.myshopify.com"])
      expect((await listShops(database.db, [appId], { q: "%" })).total).toBe(0)
      expect((await listShops(database.db, [appId], { q: "_.myshopify" })).total).toBe(0)
    })

    it("sorts by revenue and by MRR, and pages", async () => {
      await load()
      const byRevenue = (await listShops(database.db, [appId], { sort: "revenue" })).rows
      expect(byRevenue[0].shop).toBe("a.myshopify.com")
      const byMrr = (await listShops(database.db, [appId], { sort: "mrr" })).rows
      expect(byMrr[0].shop).toBe("e.myshopify.com")
      const page2 = await listShops(database.db, [appId], { sort: "shop", pageSize: 3, page: 2 })
      expect(page2.rows.map((r) => r.shop)).toEqual(["e.myshopify.com"])
      expect(page2.total).toBe(4)
    })
  })

  describe("the event log", () => {
    it("lists events newest first, with a total", async () => {
      await load()
      const { rows, total } = await listEvents(database.db, [appId], { pageSize: 5 })
      expect(total).toBe(history.length)
      expect(rows).toHaveLength(5)
      expect(rows[0].occurredAt.getTime()).toBeGreaterThanOrEqual(rows[1].occurredAt.getTime())
    })

    it("filters by type, by shop and by date, and pages through the rest", async () => {
      await load()
      expect((await listEvents(database.db, [appId], { type: "RELATIONSHIP_UNINSTALLED" })).total).toBe(4)
      expect((await listEvents(database.db, [appId], { shop: "e.my" })).total).toBe(4)
      expect((await listEvents(database.db, [appId], { range: { from: "2026-01-04", to: "2026-01-04" } })).total).toBe(1)
      const second = await listEvents(database.db, [appId], { pageSize: 10, page: 2 })
      expect(second.rows).toHaveLength(history.length - 10)
    })

    it("lists the types that exist, for the filter", async () => {
      await load()
      expect(await listEventTypes(database.db, [appId])).toContain("SUBSCRIPTION_FROZEN")
    })
  })

  describe("syncing from Shopify into the database", () => {
    const node = (id: string, eventType: string, occurredAt: string, shop: string) => ({
      id,
      occurredAt,
      eventType,
      shop: { id: "gid://shopify/Shop/1", myshopifyDomain: shop },
      subject: { __typename: "AppReference", id: APP_GID, name: "Badge Pro", apiKey: "key-1" },
      relationshipState: eventType === "RELATIONSHIP_INSTALLED" ? "INSTALLED" : "UNINSTALLED",
    })
    const response = (nodes: unknown[]) =>
      new Response(JSON.stringify({ data: { events: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((n) => ({ cursor: "c", node: n })) } } }))

    it("stores the events, moves the watermarks, and does nothing the second time", async () => {
      let call = 0
      const client = createPartnerClient({
        partnerId: "42",
        token: "tok",
        sleep: async () => {},
        fetch: async () => response(++call % 2 === 1 ? [node("e1", "RELATIONSHIP_INSTALLED", "2026-01-05T10:00:00Z", "a.myshopify.com"), node("e2", "RELATIONSHIP_UNINSTALLED", "2026-01-06T10:00:00Z", "a.myshopify.com")] : []),
      })
      const store = createDbSyncStore(database.db, connectionId)
      const options = { client, store, backfillFrom: new Date("2026-01-01T00:00:00Z"), now: NOW }

      const first = await syncConnection(options)
      expect(first).toMatchObject({ ok: true, inserted: 2, appsSeen: 1 })
      const [c] = await database.db.select().from(connections).where(eq(connections.id, connectionId))
      expect(c.coreWatermark?.toISOString()).toBe(NOW.toISOString())
      expect(c.earningsWatermark?.toISOString()).toBe(NOW.toISOString())

      const second = await syncConnection(options)
      expect(second.inserted).toBe(0)
      expect(await database.db.select().from(events)).toHaveLength(2)

      await rebuildStaleApps(database.db, NOW)
      const [stay] = await database.db.select().from(installs)
      expect(stay.shop).toBe("a.myshopify.com")
      expect(stay.uninstalledAt).not.toBeNull()
    })

    it("lists a connection with its apps, events and recent runs", async () => {
      await load()
      await database.db.insert(syncRuns).values({ connectionId, trigger: "manual", ok: true, eventsInserted: 3 })
      const [overview] = await getConnections(database.db)
      expect(overview).toMatchObject({ label: "Test org", tokenHint: "abcd", apps: 1, events: history.length })
      expect(overview.runs).toHaveLength(1)
      expect(JSON.stringify(overview)).not.toContain("tokenCiphertext")
    })
  })

  describe("demo data", () => {
    it("builds a believable history that adds up on every day", async () => {
      const now = new Date("2026-06-15T12:00:00Z")
      const { events: generated, apps: demoApps } = generateDemoEvents({ now, days: 150, seed: 7 })
      expect(demoApps).toHaveLength(3)
      expect(generated.length).toBeGreaterThan(500)
      expect(generated.every((e) => e.occurredAt.getTime() <= now.getTime())).toBe(true)
      expect(new Set(generated.map((e) => e.id)).size).toBe(generated.length)

      await insertEvents(database.db, connectionId, generated)
      await rebuildStaleApps(database.db, now)
      const all = await listApps(database.db)
      expect(all).toHaveLength(3)

      for (const app of all) {
        const days = await database.db.select().from(dailyMetrics).where(eq(dailyMetrics.appId, app.id)).orderBy(dailyMetrics.date)
        expect(days.length).toBeGreaterThan(100)
        for (const [i, d] of days.entries()) {
          for (const key of ["activeInstalls", "activeSubs", "trialSubs", "mrrCents", "trialMrrCents"] as const) {
            expect(d[key], `${app.label} ${d.date} ${key}`).toBeGreaterThanOrEqual(0)
          }
          if (i > 0) {
            const p = days[i - 1]
            expect(d.mrrCents, `${app.label} ${d.date}`).toBe(p.mrrCents + d.newMrrCents + d.expansionMrrCents - d.contractionMrrCents - d.churnedMrrCents)
            expect(d.activeInstalls, `${app.label} ${d.date}`).toBe(p.activeInstalls + d.installs - (await uninstallsOf(app.id, d.date)))
          }
        }
        const open = (await database.db.select().from(installs).where(eq(installs.appId, app.id))).filter((s) => s.uninstalledAt === null).length
        expect(days[days.length - 1].activeInstalls).toBe(open)
      }
    })

    // A day's change in installs standing is its installs less the uninstalls that ended a stay.
    async function uninstallsOf(app: string, date: string): Promise<number> {
      const rows = await database.db.select({ at: installs.uninstalledAt }).from(installs).where(eq(installs.appId, app))
      return rows.filter((r) => r.at && r.at.toISOString().slice(0, 10) === date).length
    }

    it("is repeatable for a given seed, and different for another", () => {
      const now = new Date("2026-06-15T12:00:00Z")
      const a = generateDemoEvents({ now, days: 60, seed: 3 }).events.map((e) => `${e.type}${e.occurredAt.getTime()}`)
      const b = generateDemoEvents({ now, days: 60, seed: 3 }).events.map((e) => `${e.type}${e.occurredAt.getTime()}`)
      const c = generateDemoEvents({ now, days: 60, seed: 4 }).events.map((e) => `${e.type}${e.occurredAt.getTime()}`)
      expect(a).toEqual(b)
      expect(a).not.toEqual(c)
    })
  })
})
