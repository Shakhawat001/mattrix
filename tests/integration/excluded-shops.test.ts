import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { kpisFor, stocksAt } from "@/lib/analytics/aggregate"
import { addExcludedShop, listExcludedShops, normalizeShop, removeExcludedShop } from "@/lib/analytics/excluded-shops"
import { getMrrMovers } from "@/lib/analytics/mrr-movers"
import { getDayRows, listShops } from "@/lib/analytics/queries"
import { rebuildApp, rebuildStaleApps } from "@/lib/analytics/rebuild"
import { createDatabase, type Database } from "@/lib/db/client"
import { apps, connections, dailyMetrics, events, installs } from "@/lib/db/schema"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { TEST_DATABASE_URL, clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const NOW = new Date("2026-02-10T12:00:00Z")
const BADGES = { gid: "gid://shopify/App/1", name: "Badge Pro" }
const NOTES = { gid: "gid://shopify/App/2", name: "Cart Notes" }

let counter = 0
function pe(app: typeof BADGES, type: string, day: string, shop: string | null, over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    id: `evt-${++counter}`,
    occurredAt: new Date(`${day}T12:00:00Z`),
    type,
    appGid: app.gid,
    appName: app.name,
    appApiKey: null,
    shop,
    shopGid: null,
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
const plan = (amountCents: number) => ({ amountCents, planHandle: "pro", billingPeriod: "EVERY_30_DAYS" })

// real pays $20 for Badge Pro from 1 January. dev, your own development store, has both apps: on
// Badge Pro it pays $50 from 2 January, is charged once and uninstalls on 20 January; it installs
// Cart Notes on 5 January and keeps it. One charge names no shop.
const history: ParsedEvent[] = [
  pe(BADGES, "RELATIONSHIP_INSTALLED", "2026-01-01", "real.myshopify.com"),
  pe(BADGES, "SUBSCRIPTION_CREATED", "2026-01-01", "real.myshopify.com", plan(2000)),
  pe(BADGES, "RELATIONSHIP_INSTALLED", "2026-01-02", "dev.myshopify.com"),
  pe(BADGES, "SUBSCRIPTION_CREATED", "2026-01-02", "dev.myshopify.com", plan(5000)),
  pe(BADGES, "CHARGE_RECURRING", "2026-01-02", "dev.myshopify.com", { amountCents: 5000 }),
  pe(BADGES, "CHARGE_RECURRING", "2026-01-03", null, { amountCents: 700 }),
  pe(BADGES, "RELATIONSHIP_UNINSTALLED", "2026-01-20", "dev.myshopify.com"),
  pe(NOTES, "RELATIONSHIP_INSTALLED", "2026-01-05", "dev.myshopify.com"),
]

/** Waits until some session is stuck on a lock while running a statement like `pattern`. */
async function lockWait(database: Database, pattern: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike ${pattern}`
    if (row.n > 0) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Nothing waited on a lock running: ${pattern}`)
}

describe.skipIf(!hasDatabase)("excluded shops (Postgres)", () => {
  const range = { from: "2026-01-01", to: "2026-02-10" }
  let database: Database
  let badges: string
  let notes: string

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
    await insertEvents(database.db, c.id, history)
    await rebuildStaleApps(database.db, NOW)
    const ids = new Map((await database.db.select({ id: apps.id, gid: apps.gid }).from(apps)).map((a) => [a.gid, a.id]))
    badges = ids.get(BADGES.gid)!
    notes = ids.get(NOTES.gid)!
  })

  const rowsOf = (appId: string) => getDayRows(database.db, [appId], range)
  const rollup = () => database.db.select().from(dailyMetrics).orderBy(dailyMetrics.appId, dailyMetrics.date)
  const dirty = async () => (await database.db.select({ dirty: apps.dirty }).from(apps)).map((a) => a.dirty)
  const shopsOf = async (appId: string) => (await database.db.select({ shop: installs.shop }).from(installs).where(eq(installs.appId, appId))).map((i) => i.shop).sort()

  it("leaves an excluded shop out of every app, keeps its events, and counts it again once removed", async () => {
    expect(kpisFor(await rowsOf(badges), range)).toMatchObject({ installs: 2, uninstalls: 1, newMrr: 7000, churnedMrr: 5000, mrr: 2000, charged: 5700 })
    expect(stocksAt(await rowsOf(badges), "2026-01-10").mrrCents).toBe(7000)
    expect(kpisFor(await rowsOf(notes), range)).toMatchObject({ installs: 1, activeInstalls: 1 })
    const before = await rollup()

    expect(await addExcludedShop(database.db, normalizeShop("DEV.myshopify.com")!, "Our development store")).toBe(true)
    expect(await dirty()).toEqual([true, true])
    expect(await rebuildStaleApps(database.db, NOW)).toBe(2)

    // Badge Pro is real alone. The charge that names no shop still counts.
    expect(kpisFor(await rowsOf(badges), range)).toMatchObject({ installs: 1, uninstalls: 0, newMrr: 2000, churnedMrr: 0, mrr: 2000, charged: 700 })
    expect(stocksAt(await rowsOf(badges), "2026-01-10").mrrCents).toBe(2000)
    // Cart Notes had nobody else, so it has nothing to count.
    expect(await rowsOf(notes)).toEqual([])
    expect((await listShops(database.db, [badges, notes])).rows.map((r) => r.shop)).toEqual(["real.myshopify.com"])
    expect(await database.db.select().from(events)).toHaveLength(history.length)

    // No derived row names the shop, so what reads those tables leaves it out too and still matches the rollup.
    expect((await database.sql<{ shop: string }[]>`select shop from installs union select shop from subscriptions union select shop from trials`).map((r) => r.shop)).toEqual(["real.myshopify.com"])
    const movers = await getMrrMovers(database.db, [badges, notes], range, "UTC")
    const both = kpisFor(await getDayRows(database.db, [badges, notes], range), range)
    expect(movers.moves.map((m) => m.shop)).toEqual(["real.myshopify.com"])
    expect(movers.totals).toMatchObject({ newMrrCents: both.newMrr, expansionMrrCents: both.expansionMrr, contractionMrrCents: both.contractionMrr, churnedMrrCents: both.churnedMrr, newSubs: both.newSubs, canceledSubs: both.canceledSubs })

    expect(await removeExcludedShop(database.db, "dev.myshopify.com")).toBe(true)
    expect(await dirty()).toEqual([true, true])
    expect(await rebuildStaleApps(database.db, NOW)).toBe(2)
    expect(await rollup()).toEqual(before)
  })

  it("lists each shop once with its first note, and marks nothing when there was nothing to change", async () => {
    expect(await addExcludedShop(database.db, "dev.myshopify.com", "Our development store")).toBe(true)
    expect(await addExcludedShop(database.db, "review.myshopify.com", null)).toBe(true)
    await rebuildStaleApps(database.db, NOW)

    expect(await addExcludedShop(database.db, "dev.myshopify.com", "Something else")).toBe(false)
    expect(await removeExcludedShop(database.db, "never.myshopify.com")).toBe(false)
    expect(await dirty()).toEqual([false, false])

    const list = await listExcludedShops(database.db)
    expect(list.map(({ shop, note }) => ({ shop, note }))).toEqual([
      { shop: "dev.myshopify.com", note: "Our development store" },
      { shop: "review.myshopify.com", note: null },
    ])
    expect(list[0].createdAt).toBeInstanceOf(Date)
  })

  it("does not lose a change made while an app is being rebuilt: the app is marked to be rebuilt again", async () => {
    // A second session holds one of Badge Pro's stays, so the rebuild stops after it has read the
    // events and before it writes. The shop is excluded while it waits.
    const other = createDatabase(TEST_DATABASE_URL as string, { max: 2 })
    const held = await other.sql.reserve()
    const work: Promise<unknown>[] = []
    try {
      await held`begin`
      await held`select 1 from installs where app_id = ${badges} for update`
      work.push(rebuildApp(database.db, badges, "UTC", NOW))
      await lockWait(other, 'delete from "installs"%')
      work.push(addExcludedShop(database.db, "dev.myshopify.com", null))
      // Marking the app waits for the rebuild to finish. Without that wait it is done already, and the check below fails.
      await lockWait(other, 'update "apps" set "dirty"%').catch(() => {})
    } finally {
      await held`rollback`.catch(() => {})
      held.release()
    }
    await Promise.all(work)
    await other.close()

    // The rebuild wrote what it read before the change, and the change marked the app again.
    expect(await shopsOf(badges)).toEqual(["dev.myshopify.com", "real.myshopify.com"])
    expect(await dirty()).toEqual([true, true])
    await rebuildStaleApps(database.db, NOW)
    expect(await shopsOf(badges)).toEqual(["real.myshopify.com"])
  })

  it("rebuilds nothing for an app that no longer exists", async () => {
    const before = await rollup()
    await expect(rebuildApp(database.db, "00000000-0000-4000-8000-000000000000", "UTC", NOW)).resolves.toBeUndefined()
    expect(await rollup()).toEqual(before)
  })
})
