import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { getRevenueCohorts } from "@/lib/analytics/revenue-cohorts"
import { getWinBack } from "@/lib/analytics/win-back"
import type { Database } from "@/lib/db/client"
import { apps, connections } from "@/lib/db/schema"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const APP_GID = "gid://shopify/App/1"
const OTHER_GID = "gid://shopify/App/2"

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
const other = { appGid: OTHER_GID, appName: "Other App", appApiKey: "key-2" }

describe.skipIf(!hasDatabase)("cohorts and win-back (Postgres)", () => {
  let database: Database
  let connectionId: string

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

  async function load(list: ParsedEvent[], now: Date): Promise<Record<string, string>> {
    await insertEvents(database.db, connectionId, list)
    await rebuildStaleApps(database.db, now)
    const rows = await database.db.select({ id: apps.id, gid: apps.gid }).from(apps).where(eq(apps.connectionId, connectionId))
    return Object.fromEntries(rows.map((r) => [r.gid, r.id]))
  }

  describe("revenue cohorts", () => {
    const NOW = new Date("2026-05-10T12:00:00Z")

    // Every event at noon UTC. All monthly plans.
    //   a  $20 from 5 Jan, no trial; up to $30 on 10 Feb; cancels 15 Apr.
    //   b  $10 with a 7-day trial from 10 Jan, so it pays from 17 Jan; cancels 20 Mar.
    //   c  $50 with a 14-day trial from 20 Jan, so it pays from 3 Feb (a February shop); down to $30 on 10 Mar.
    //   d  $40 with a 30-day trial from 25 Jan, canceled inside it on 1 Feb: never paid.
    //   e  a free plan from 8 Jan; moves to $15 on 5 Mar; uninstalls 20 Apr.
    //   f  $25 from 20 Dec 2025; cancels 10 Jan; subscribes again on 15 Feb.
    // In the other app, a also pays $9 from 6 Jan.
    const history: ParsedEvent[] = [
      pe("RELATIONSHIP_INSTALLED", "2026-01-05", "a.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-05", "a.myshopify.com", monthly(2000)),
      pe("SUBSCRIPTION_UPDATED", "2026-02-10", "a.myshopify.com", monthly(3000)),
      pe("SUBSCRIPTION_CANCELED", "2026-04-15", "a.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-10", "b.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-10", "b.myshopify.com", monthly(1000, 7)),
      pe("SUBSCRIPTION_CANCELED", "2026-03-20", "b.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-20", "c.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-20", "c.myshopify.com", monthly(5000, 14)),
      pe("SUBSCRIPTION_UPDATED", "2026-03-10", "c.myshopify.com", monthly(3000)),

      pe("RELATIONSHIP_INSTALLED", "2026-01-25", "d.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-25", "d.myshopify.com", monthly(4000, 30)),
      pe("SUBSCRIPTION_CANCELED", "2026-02-01", "d.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-08", "e.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-08", "e.myshopify.com", { amountCents: 0, planHandle: "free", billingPeriod: "EVERY_30_DAYS" }),
      pe("SUBSCRIPTION_UPDATED", "2026-03-05", "e.myshopify.com", monthly(1500, null, "basic")),
      pe("RELATIONSHIP_UNINSTALLED", "2026-04-20", "e.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2025-12-20", "f.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2025-12-20", "f.myshopify.com", monthly(2500)),
      pe("SUBSCRIPTION_CANCELED", "2026-01-10T15:00:00Z", "f.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-02-15", "f.myshopify.com", monthly(2500)),

      pe("RELATIONSHIP_INSTALLED", "2026-01-06", "a.myshopify.com", other),
      pe("SUBSCRIPTION_CREATED", "2026-01-06", "a.myshopify.com", { ...monthly(900), ...other }),
    ]
    const firstQuarter = { from: "2026-01-01", to: "2026-03-31" }

    it("groups shops by the month they first paid and follows their MRR month by month", async () => {
      const ids = await load(history, NOW)
      const rows = await getRevenueCohorts(database.db, [ids[APP_GID]], firstQuarter, "UTC", NOW)

      // January: a ($20) and b ($10, paying from its conversion on 17 Jan). They started with $30.
      //   end of Jan: a $20 + b $10 = $30 (100%)
      //   end of Feb: a $30 after its upgrade + b $10 = $40 (133%)
      //   end of Mar: a $30; b canceled on the 20th = $30 (100%)
      //   end of Apr: a canceled on the 15th = $0
      //   end of May: not over on 10 May
      // February: c, whose trial converted on 3 Feb, started with $50.
      //   end of Feb $50 (100%), end of Mar $30 after its downgrade (60%), end of Apr $30 (60%)
      // March: e, paying from its move off the free plan on 5 Mar, started with $15.
      //   end of Mar $15 (100%), end of Apr $0 after its uninstall
      // d never paid, and f first paid in December 2025, before the range.
      expect(rows.map((r) => ({ cohort: r.cohort, shops: r.shops, startMrr: r.startMrr }))).toEqual([
        { cohort: "2026-01-01", shops: 2, startMrr: 3000 },
        { cohort: "2026-02-01", shops: 1, startMrr: 5000 },
        { cohort: "2026-03-01", shops: 1, startMrr: 1500 },
      ])
      const [jan, feb, mar] = rows
      expect(jan.cells.slice(0, 5)).toEqual([
        { mrr: 3000, shops: 2, share: 1 },
        { mrr: 4000, shops: 2, share: 4000 / 3000 },
        { mrr: 3000, shops: 1, share: 1 },
        { mrr: 0, shops: 0, share: 0 },
        null,
      ])
      expect(feb.cells.slice(0, 4)).toEqual([{ mrr: 5000, shops: 1, share: 1 }, { mrr: 3000, shops: 1, share: 0.6 }, { mrr: 3000, shops: 1, share: 0.6 }, null])
      expect(mar.cells.slice(0, 3)).toEqual([{ mrr: 1500, shops: 1, share: 1 }, { mrr: 0, shops: 0, share: 0 }, null])
      for (const row of rows) expect(row.cells).toHaveLength(12)
      expect(jan.cells.slice(4).every((c) => c === null)).toBe(true)
    })

    it("counts a shop that leaves and comes back as paying again", async () => {
      const ids = await load(history, NOW)
      const [dec] = await getRevenueCohorts(database.db, [ids[APP_GID]], { from: "2025-12-01", to: "2025-12-31" }, "UTC", NOW)
      // f started with $25 on 20 Dec: paying at the end of December, gone at the end of January
      // (canceled on the 10th), paying again from 15 Feb through the end of April.
      expect(dec).toMatchObject({ cohort: "2025-12-01", shops: 1, startMrr: 2500 })
      expect(dec.cells.slice(0, 6).map((c) => c?.share ?? null)).toEqual([1, 0, 1, 1, 1, null])
    })

    it("does not count a shop back on a new free trial as paying until the trial converts", async () => {
      const ids = await load(
        [
          pe("RELATIONSHIP_INSTALLED", "2026-01-05", "g.myshopify.com"),
          pe("SUBSCRIPTION_CREATED", "2026-01-05", "g.myshopify.com", monthly(2000)),
          pe("RELATIONSHIP_UNINSTALLED", "2026-02-20", "g.myshopify.com"),
          pe("RELATIONSHIP_INSTALLED", "2026-03-25", "g.myshopify.com"),
          pe("SUBSCRIPTION_CREATED", "2026-03-25", "g.myshopify.com", monthly(2000, 14)),
        ],
        NOW,
      )
      // g pays $20 from 5 Jan and leaves on 20 Feb. It returns on 25 Mar with a 14-day trial, which
      // is still running at the end of March and converts on 8 Apr.
      const [jan] = await getRevenueCohorts(database.db, [ids[APP_GID]], firstQuarter, "UTC", NOW)
      expect(jan).toMatchObject({ cohort: "2026-01-01", shops: 1, startMrr: 2000 })
      expect(jan.cells.slice(0, 5).map((c) => c?.mrr ?? null)).toEqual([2000, 0, 0, 2000, null])
    })

    it("takes the cohorts from the range and the apps from the filter", async () => {
      const ids = await load(history, NOW)
      expect((await getRevenueCohorts(database.db, [ids[APP_GID]], { from: "2026-02-01", to: "2026-02-28" }, "UTC", NOW)).map((r) => r.cohort)).toEqual(["2026-02-01"])
      // Only part of a month in the range: b first paid on 17 Jan, a on the 5th.
      expect(await getRevenueCohorts(database.db, [ids[APP_GID]], { from: "2026-01-10", to: "2026-01-31" }, "UTC", NOW)).toMatchObject([{ cohort: "2026-01-01", shops: 1, startMrr: 1000 }])

      // The same shop in two apps is two customers: a's $9 in the other app joins January.
      const both = await getRevenueCohorts(database.db, [ids[APP_GID], ids[OTHER_GID]], firstQuarter, "UTC", NOW)
      expect(both[0]).toMatchObject({ cohort: "2026-01-01", shops: 3, startMrr: 3900 })
      expect(both[0].cells.slice(0, 4).map((c) => c?.mrr)).toEqual([3900, 4900, 3900, 900])
      expect((await getRevenueCohorts(database.db, [ids[OTHER_GID]], firstQuarter, "UTC", NOW))[0]).toMatchObject({ shops: 1, startMrr: 900 })
    })

    it("returns nothing for no apps, and for a range in which nobody first paid", async () => {
      const ids = await load(history, NOW)
      expect(await getRevenueCohorts(database.db, [], firstQuarter, "UTC", NOW)).toEqual([])
      expect(await getRevenueCohorts(database.db, [ids[APP_GID]], { from: "2026-04-01", to: "2026-04-30" }, "UTC", NOW)).toEqual([])
    })

    it("counts a yearly plan at a twelfth of its price", async () => {
      const ids = await load(
        [
          pe("RELATIONSHIP_INSTALLED", "2026-01-05", "y.myshopify.com"),
          pe("SUBSCRIPTION_CREATED", "2026-01-05", "y.myshopify.com", { amountCents: 24000, billingPeriod: "ANNUAL", planHandle: "yearly" }),
        ],
        NOW,
      )
      const [jan] = await getRevenueCohorts(database.db, [ids[APP_GID]], firstQuarter, "UTC", NOW)
      expect(jan).toMatchObject({ shops: 1, startMrr: 2000 })
      expect(jan.cells[0]).toEqual({ mrr: 2000, shops: 1, share: 1 })
    })
  })

  describe("win-back", () => {
    const NOW = new Date("2026-03-01T12:00:00Z")

    // Every event at noon UTC, so the days between them are whole.
    //   p  leaves 10 Jan, back 17 Jan (7 days)
    //   q  leaves 12 Jan, back 11 Feb (30 days); leaves again 20 Feb, back 25 Feb (5 days)
    //   r  leaves 15 Jan and stays away
    //   s  leaves 5 Feb, back 7 Feb (2 days)
    //   t  leaves 20 Dec 2025, back 8 Jan (19 days)
    //   u  an uninstall on 20 Jan whose install was never seen, then installs on 22 Jan
    const history: ParsedEvent[] = [
      pe("RELATIONSHIP_INSTALLED", "2026-01-02", "p.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-10", "p.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-01-17", "p.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-03", "q.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-12", "q.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-02-11", "q.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-02-20", "q.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-02-25", "q.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-04", "r.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-15", "r.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2026-01-05", "s.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-02-05", "s.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-02-07", "s.myshopify.com"),

      pe("RELATIONSHIP_INSTALLED", "2025-12-01", "t.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2025-12-20", "t.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-01-08", "t.myshopify.com"),

      pe("RELATIONSHIP_UNINSTALLED", "2026-01-20", "u.myshopify.com"),
      pe("RELATIONSHIP_INSTALLED", "2026-01-22", "u.myshopify.com"),
    ]
    const shopsOf = (w: { recent: { shop: string }[] }) => w.recent.map((r) => r.shop.split(".")[0])

    it("follows the shops that left in the range up to today", async () => {
      const ids = await load(history, NOW)
      // January: p, q and r left (t left in December; u's uninstall has no stay to end).
      // p came back after 7 days and q after 30, in February, which still counts. r did not.
      const w = await getWinBack(database.db, [ids[APP_GID]], { from: "2026-01-01", to: "2026-01-31" }, "UTC")
      expect(w).toMatchObject({ left: 3, returned: 2, medianDays: 18.5 })
      expect(w.rate).toBeCloseTo(2 / 3)
      expect(shopsOf(w)).toEqual(["q", "p"])
      expect(w.recent[0].leftAt).toBeInstanceOf(Date)
      expect(w.recent[0].leftAt.toISOString()).toBe("2026-01-12T12:00:00.000Z")
      expect(w.recent[0].backAt.toISOString()).toBe("2026-02-11T12:00:00.000Z")
      expect(w.recent.map((r) => r.days)).toEqual([30, 7])
    })

    it("counts a shop once, from the first time it left in the range", async () => {
      const ids = await load(history, NOW)
      // February: s left on the 5th and q on the 20th; both came back, after 2 and 5 days.
      const feb = await getWinBack(database.db, [ids[APP_GID]], { from: "2026-02-01", to: "2026-02-28" }, "UTC")
      expect(feb).toMatchObject({ left: 2, returned: 2, rate: 1, medianDays: 3.5 })
      expect(shopsOf(feb)).toEqual(["q", "s"])

      // January and February together: p, q, r and s left. q is counted from 12 Jan, so its
      // return is the one on 11 Feb (30 days). The returns took 7, 30 and 2 days.
      const both = await getWinBack(database.db, [ids[APP_GID]], { from: "2026-01-01", to: "2026-02-28" }, "UTC")
      expect(both).toMatchObject({ left: 4, returned: 3, rate: 0.75, medianDays: 7 })
      expect(shopsOf(both)).toEqual(["q", "s", "p"])
      expect(both.recent[0].days).toBe(30)
    })

    it("keeps the count when the list is cut short", async () => {
      const ids = await load(history, NOW)
      const w = await getWinBack(database.db, [ids[APP_GID]], { from: "2026-01-01", to: "2026-02-28" }, "UTC", 1)
      expect(w).toMatchObject({ left: 4, returned: 3 })
      expect(shopsOf(w)).toEqual(["q"])
    })

    it("has no rate and no median when nobody left, and nothing for no apps", async () => {
      const ids = await load(history, NOW)
      const none = { left: 0, returned: 0, rate: null, medianDays: null, recent: [] }
      expect(await getWinBack(database.db, [ids[APP_GID]], { from: "2026-03-01", to: "2026-03-01" }, "UTC")).toEqual(none)
      expect(await getWinBack(database.db, [], { from: "2026-01-01", to: "2026-01-31" }, "UTC")).toEqual(none)
      // r left and never came back: a rate of zero and no median, not n/a for both.
      expect(await getWinBack(database.db, [ids[APP_GID]], { from: "2026-01-15", to: "2026-01-15" }, "UTC")).toMatchObject({ left: 1, returned: 0, rate: 0, medianDays: null })
    })
  })
})
