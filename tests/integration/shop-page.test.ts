import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { listShops } from "@/lib/analytics/queries"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { getShopTimeline } from "@/lib/analytics/shop-timeline"
import { getShopTotals } from "@/lib/analytics/shop-totals"
import type { Database } from "@/lib/db/client"
import { apps, connections } from "@/lib/db/schema"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const NOW = new Date("2026-02-10T12:00:00Z")
const APP_GID = "gid://shopify/App/1"

let counter = 0
function pe(type: string, when: string, shop: string | null, over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    id: `evt-${++counter}`,
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

describe.skipIf(!hasDatabase)("what the shop page reads (Postgres)", () => {
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
      .values({ label: "Test org", partnerId: "42", tokenCiphertext: "secret-ciphertext", tokenHint: "zq9x", backfillFrom: new Date("2025-01-01") })
      .returning({ id: connections.id })
    connectionId = c.id
    await insertEvents(database.db, connectionId, [
      pe("RELATIONSHIP_INSTALLED", "2026-01-01", "a.myshopify.com"),
      pe("SUBSCRIPTION_CREATED", "2026-01-01", "a.myshopify.com", { amountCents: 2000, planHandle: "pro", billingPeriod: "EVERY_30_DAYS" }),
      pe("CHARGE_RECURRING", "2026-01-01", "a.myshopify.com", { amountCents: 2000 }),
      pe("CHARGE_RECURRING", "2026-01-31", "a.myshopify.com", { amountCents: 2000 }),
      pe("CHARGE_ONE_TIME", "2026-01-05", "a.myshopify.com", { amountCents: 5000 }),
      pe("CHARGE_USAGE", "2026-01-06", "a.myshopify.com", { amountCents: 125 }),
      pe("EARNING_CHARGE_RECURRING", "2026-01-03", "a.myshopify.com", { grossCents: 2000, netCents: 1700, feeCents: 300 }),
      pe("EARNING_CHARGE_RECURRING", "2026-02-02", "a.myshopify.com", { grossCents: 2000, netCents: 1700, feeCents: 300 }),
      pe("EARNING_REFUND", "2026-02-04", "a.myshopify.com", { grossCents: -2000, netCents: -1700, feeCents: -300 }),
      // A refund with only a net amount counts by that.
      pe("EARNING_REFUND", "2026-02-05", "a.myshopify.com", { netCents: -300 }),
      pe("EARNING_ADJUSTMENT", "2026-02-06", "a.myshopify.com", { netCents: -100 }),
      // Not money the shop paid: a credit, and the price on a subscription event.
      pe("CREDIT_APPLIED", "2026-01-20", "a.myshopify.com", { amountCents: 500 }),
      // Other shops, and the same shop in another app.
      pe("RELATIONSHIP_INSTALLED", "2026-01-02", "c.myshopify.com"),
      pe("CHARGE_RECURRING", "2026-01-02", "c.myshopify.com", { amountCents: 1000 }),
      pe("CHARGE_RECURRING", "2026-01-02", "b.myshopify.com", { amountCents: 999 }),
      pe("CHARGE_RECURRING", "2026-01-02", "a.myshopify.com", { amountCents: 7777, appGid: "gid://shopify/App/2", appName: "Other" }),
    ])
    await rebuildStaleApps(database.db, NOW)
    const [app] = await database.db.select({ id: apps.id }).from(apps).where(eq(apps.gid, APP_GID))
    appId = app.id
  })

  it("adds up every charge, refund and earning of the shop in the app, and nothing else", async () => {
    expect(await getShopTotals(database.db, appId, "a.myshopify.com")).toEqual({
      chargedCents: 2000 + 2000 + 5000 + 125,
      refundedCents: 2000 + 300,
      netEarnedCents: 1700 + 1700 - 1700 - 300 - 100,
    })
  })

  it("is what the shops page shows as charged in all", async () => {
    const { rows } = await listShops(database.db, [appId], { sort: "shop" })
    for (const shop of ["a.myshopify.com", "c.myshopify.com"]) {
      expect((await getShopTotals(database.db, appId, shop)).chargedCents).toBe(rows.find((r) => r.shop === shop)?.charged)
    }
  })

  it("has no net earnings for a shop with no earnings event, and zeros for a shop with no events", async () => {
    expect(await getShopTotals(database.db, appId, "c.myshopify.com")).toEqual({ chargedCents: 1000, refundedCents: 0, netEarnedCents: null })
    expect(await getShopTotals(database.db, appId, "nobody.myshopify.com")).toEqual({ chargedCents: 0, refundedCents: 0, netEarnedCents: null })
  })

  it("finds the shop whatever its case or spaces around it, and reads the same in a read-only transaction", async () => {
    const plain = await getShopTotals(database.db, appId, "a.myshopify.com")
    expect(await getShopTotals(database.db, appId, "  A.MyShopify.COM ")).toEqual(plain)
    expect(await database.db.transaction((tx) => getShopTotals(tx, appId, "a.myshopify.com"), { accessMode: "read only" })).toEqual(plain)
  })

  it("lists a shop's events on the same instant in the order derive() reads them", async () => {
    // Stored in another order: the deactivation must come first, so the cancel and the uninstall
    // with it read as the store going inactive, and the reactivation last.
    await insertEvents(database.db, connectionId, [
      pe("RELATIONSHIP_INSTALLED", "2026-01-10T09:00:00Z", "x.myshopify.com"),
      pe("RELATIONSHIP_REACTIVATED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
      pe("RELATIONSHIP_UNINSTALLED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
      pe("SUBSCRIPTION_CANCELED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
      pe("CHARGE_RECURRING", "2026-01-20T10:00:00Z", "x.myshopify.com", { amountCents: 1000 }),
      pe("RELATIONSHIP_DEACTIVATED", "2026-01-20T10:00:00Z", "x.myshopify.com"),
    ])
    const t = await getShopTimeline(database.db, appId, "x.myshopify.com")
    expect(t!.events.map((e) => e.type)).toEqual([
      "RELATIONSHIP_INSTALLED", "RELATIONSHIP_DEACTIVATED", "SUBSCRIPTION_CANCELED", "CHARGE_RECURRING", "RELATIONSHIP_UNINSTALLED", "RELATIONSHIP_REACTIVATED",
    ])
  })
})
