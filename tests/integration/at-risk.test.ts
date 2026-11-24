import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getAtRisk } from "@/lib/analytics/at-risk"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import type { Database } from "@/lib/db/client"
import { apps, connections } from "@/lib/db/schema"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const APP_GID = "gid://shopify/App/1"
const OTHER_GID = "gid://shopify/App/2"
const NOW = new Date("2026-03-10T12:00:00Z")
const DAY = 86_400_000

let counter = 0
function pe(type: string, when: string, shop: string, over: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    id: `evt-${++counter}`,
    occurredAt: new Date(when.length === 10 ? `${when}T12:00:00Z` : when),
    type,
    appGid: APP_GID,
    appName: "Badge Pro",
    appApiKey: "key-1",
    shop: `${shop}.myshopify.com`,
    shopGid: `gid://shopify/Shop/${shop}`,
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
/** Shopify's cancelEffectiveOn, stored as the start of that UTC day. */
const effective = (day: string) => ({ cancelEffectiveOn: new Date(`${day}T00:00:00Z`) })
const other = { appGid: OTHER_GID, appName: "Other App", appApiKey: "key-2" }
const paying = (shop: string, day: string, plan: Partial<ParsedEvent>, over: Partial<ParsedEvent> = {}) => [
  pe("RELATIONSHIP_INSTALLED", day, shop, over),
  pe("SUBSCRIPTION_CREATED", day, shop, { ...plan, ...over }),
]

// Every event at noon UTC, rebuilt and read on 10 March 2026 unless a test says otherwise.
//   a  $20 from 1 Feb. On 1 Mar its cancel is scheduled for 25 Mar: set to end.
//   b  $120 a year ($10 a month) from 15 Jan. On 5 Mar a cancel that takes effect on 15 Jan 2027: set to end.
//   c  $30 from 1 Feb. On 20 Feb its cancel is scheduled for 5 Mar, which has passed: churned, not at risk.
//   d  $50 with a 14-day trial from 1 Mar: ends 15 Mar, inside the next 7 days.
//   e  $40 with a 14-day trial from 5 Mar: ends 19 Mar, after the next 7 days.
//   f  $25 with a 14-day trial from 28 Feb, ending 14 Mar; on 9 Mar a cancel for 12 Mar: it will not convert.
//   g  a free plan with a 7-day trial from 8 Mar: adds nothing to MRR.
//   h  $15 from 1 Jan, frozen 20 Feb: frozen.
//   i  $35 from 1 Jan, frozen 1 Feb, uninstalled 10 Feb: cannot come back.
//   j  $45 from 1 Jan, frozen 15 Jan, unfrozen 25 Jan: back, and paying.
//   k  $55 from 1 Nov 2025, frozen 1 Dec 2025: more than 90 days ago.
//   l  $60 with a 7-day trial from 1 Mar, frozen 3 Mar: never paid.
//   m  $12 from 1 Feb, frozen 1 Mar, canceled 5 Mar: cannot come back.
//   n  $18 from 1 Jan, frozen 10 Feb, subscribed again 20 Feb: back, and paying.
// In the other app, a pays $9 from 1 Feb, and on 2 Mar its cancel is scheduled for 20 Mar.
const history: ParsedEvent[] = [
  ...paying("a", "2026-02-01", monthly(2000)),
  pe("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-03-01", "a", effective("2026-03-25")),
  ...paying("b", "2026-01-15", { amountCents: 12000, billingPeriod: "ANNUAL", planHandle: "yearly" }),
  pe("SUBSCRIPTION_CANCELED", "2026-03-05", "b", effective("2027-01-15")),
  ...paying("c", "2026-02-01", monthly(3000)),
  pe("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-02-20", "c", effective("2026-03-05")),
  ...paying("d", "2026-03-01", monthly(5000, 14)),
  ...paying("e", "2026-03-05", monthly(4000, 14)),
  ...paying("f", "2026-02-28", monthly(2500, 14)),
  pe("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-03-09", "f", effective("2026-03-12")),
  ...paying("g", "2026-03-08", { ...monthly(0, 7), planHandle: "free" }),
  ...paying("h", "2026-01-01", monthly(1500, null, "basic")),
  pe("SUBSCRIPTION_FROZEN", "2026-02-20", "h"),
  ...paying("i", "2026-01-01", monthly(3500)),
  pe("SUBSCRIPTION_FROZEN", "2026-02-01", "i"),
  pe("RELATIONSHIP_UNINSTALLED", "2026-02-10", "i"),
  ...paying("j", "2026-01-01", monthly(4500)),
  pe("SUBSCRIPTION_FROZEN", "2026-01-15", "j"),
  pe("SUBSCRIPTION_UNFROZEN", "2026-01-25", "j"),
  ...paying("k", "2025-11-01", monthly(5500)),
  pe("SUBSCRIPTION_FROZEN", "2025-12-01", "k"),
  ...paying("l", "2026-03-01", monthly(6000, 7)),
  pe("SUBSCRIPTION_FROZEN", "2026-03-03", "l"),
  ...paying("m", "2026-02-01", monthly(1200)),
  pe("SUBSCRIPTION_FROZEN", "2026-03-01", "m"),
  pe("SUBSCRIPTION_CANCELED", "2026-03-05", "m"),
  ...paying("n", "2026-01-01", monthly(1800)),
  pe("SUBSCRIPTION_FROZEN", "2026-02-10", "n"),
  pe("SUBSCRIPTION_CREATED", "2026-02-20", "n", monthly(1800)),
  ...paying("a", "2026-02-01", monthly(900), other),
  pe("SUBSCRIPTION_CANCELLATION_SCHEDULED", "2026-03-02", "a", { ...effective("2026-03-20"), ...other }),
]

const shops = (list: { rows: { shop: string }[] }) => list.rows.map((r) => r.shop.split(".")[0])

describe.skipIf(!hasDatabase)("at risk (Postgres)", () => {
  let database: Database
  let ids: Record<string, string>

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
    const rows = await database.db.select({ id: apps.id, gid: apps.gid }).from(apps).where(eq(apps.connectionId, c.id))
    ids = Object.fromEntries(rows.map((r) => [r.gid, r.id]))
  })

  it("lists the paying subscriptions set to end, soonest first, with the MRR they take", async () => {
    const { setToEnd } = await getAtRisk(database.db, [ids[APP_GID]], NOW)
    // a ($20, ends 25 Mar) and b ($10 a month, ends 15 Jan 2027): $30. c ended on 5 Mar.
    expect(setToEnd).toEqual({
      count: 2,
      mrrCents: 3000,
      rows: [
        { appId: ids[APP_GID], shop: "a.myshopify.com", planHandle: "pro", billingPeriod: "EVERY_30_DAYS", monthlyCents: 2000, scheduledAt: new Date("2026-03-01T12:00:00Z"), endsAt: new Date("2026-03-25T00:00:00Z") },
        { appId: ids[APP_GID], shop: "b.myshopify.com", planHandle: "yearly", billingPeriod: "ANNUAL", monthlyCents: 1000, scheduledAt: new Date("2026-03-05T12:00:00Z"), endsAt: new Date("2027-01-15T00:00:00Z") },
      ],
    })
  })

  it("lists the trials of paid plans that end in the next 7 days and would convert", async () => {
    const { trialsEnding } = await getAtRisk(database.db, [ids[APP_GID]], NOW)
    // d ends on 15 Mar and would add $50. e ends after 17 Mar, f is set to end before its trial
    // does, g is on a free plan, and l was frozen.
    expect(trialsEnding).toEqual({
      count: 1,
      mrrCents: 5000,
      rows: [{ appId: ids[APP_GID], shop: "d.myshopify.com", planHandle: "pro", billingPeriod: "EVERY_30_DAYS", monthlyCents: 5000, endsAt: new Date("2026-03-15T12:00:00Z") }],
    })
  })

  it("lists the paying subscriptions frozen in the last 90 days that have not come back", async () => {
    const { frozen } = await getAtRisk(database.db, [ids[APP_GID]], NOW)
    // h, frozen on 20 Feb, would bring back $15. i uninstalled and m canceled after the freeze, j
    // resumed, n subscribed again, k was frozen 99 days ago, and l never paid.
    expect(frozen).toEqual({
      count: 1,
      mrrCents: 1500,
      rows: [{ appId: ids[APP_GID], shop: "h.myshopify.com", planHandle: "basic", billingPeriod: "EVERY_30_DAYS", monthlyCents: 1500, frozenAt: new Date("2026-02-20T12:00:00Z") }],
    })
  })

  it("drops what has ended since the last rebuild, and moves its windows with the moment", async () => {
    // Read on 26 Mar from the rows built on 10 Mar: a's cancel took effect on the 25th, and the
    // trials of d and e have ended.
    const later = await getAtRisk(database.db, [ids[APP_GID]], new Date(NOW.getTime() + 16 * DAY))
    expect(shops(later.setToEnd)).toEqual(["b"])
    expect(later.setToEnd.mrrCents).toBe(1000)
    expect(later.trialsEnding).toEqual({ count: 0, mrrCents: 0, rows: [] })
    expect(shops(later.frozen)).toEqual(["h"])

    // On 13 Mar the next 7 days reach 20 Mar, which takes in e's trial too.
    expect(shops((await getAtRisk(database.db, [ids[APP_GID]], new Date("2026-03-13T12:00:00Z"))).trialsEnding)).toEqual(["d", "e"])
    // h was frozen 90 days before 21 May at noon, and is past the window a day later.
    expect(shops((await getAtRisk(database.db, [ids[APP_GID]], new Date("2026-05-21T00:00:00Z"))).frozen)).toEqual(["h"])
    expect((await getAtRisk(database.db, [ids[APP_GID]], new Date("2026-05-22T12:00:00Z"))).frozen.count).toBe(0)
  })

  it("covers the chosen apps together, and nothing for no apps", async () => {
    const both = await getAtRisk(database.db, [ids[APP_GID], ids[OTHER_GID]], NOW)
    // The same shop in the other app is another subscription: $9 ending on 20 Mar comes first.
    expect(both.setToEnd.rows.map((r) => [r.appId, r.shop, r.monthlyCents])).toEqual([
      [ids[OTHER_GID], "a.myshopify.com", 900],
      [ids[APP_GID], "a.myshopify.com", 2000],
      [ids[APP_GID], "b.myshopify.com", 1000],
    ])
    expect(both.setToEnd).toMatchObject({ count: 3, mrrCents: 3900 })
    expect(both.trialsEnding.count).toBe(1)
    expect(both.frozen.count).toBe(1)
    expect((await getAtRisk(database.db, [ids[OTHER_GID]], NOW)).setToEnd).toMatchObject({ count: 1, mrrCents: 900 })

    const nothing = { count: 0, mrrCents: 0, rows: [] }
    expect(await getAtRisk(database.db, [], NOW)).toEqual({ at: NOW, setToEnd: nothing, trialsEnding: nothing, frozen: nothing })
  })

  it("keeps the totals when the list is cut short", async () => {
    const risk = await getAtRisk(database.db, [ids[APP_GID], ids[OTHER_GID]], NOW, 1)
    expect(risk.setToEnd).toMatchObject({ count: 3, mrrCents: 3900 })
    expect(shops(risk.setToEnd)).toEqual(["a"])
    expect(risk.setToEnd.rows[0].appId).toBe(ids[OTHER_GID])
  })

  it("reads the same inside a read-only transaction", async () => {
    const appIds = [ids[APP_GID], ids[OTHER_GID]]
    const inside = await database.db.transaction((tx) => getAtRisk(tx, appIds, NOW), { accessMode: "read only" })
    expect(inside).toEqual(await getAtRisk(database.db, appIds, NOW))
  })
})
