import { describe, expect, it } from "vitest"
import { createPartnerClient, PartnerApiError, validateApiVersion, validatePartnerId } from "@/lib/partner/client"
import { parseEventNode, parseLegacyEventNode, type ParsedEvent } from "@/lib/partner/parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY, LEGACY_EVENT_TYPES, LEGACY_EVENTS_QUERY, partnersAppId } from "@/lib/partner/query"
import { syncConnection, type SyncPass, type SyncStore } from "@/lib/partner/sync"

const TOKEN = "tok_secret_123"
const NOW = new Date("2026-11-22T12:00:00Z")

// ---------------------------------------------------------------------------
// Fakes: a network that records calls, a clock that only moves when told, a store in memory
// ---------------------------------------------------------------------------

type Variables = {
  /** The newer events query. */
  filter: Record<string, unknown>
  cursor: string | null
  /** The older App.events. */
  appId?: string
  types?: string[]
  occurredAtMin?: string
  occurredAtMax?: string
}
type Call = { url: string; headers: Record<string, string>; body: { query: string; variables: Variables }; at: number }

function fakeNetwork(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const slept: number[] = []
  let clock = 1_800_000_000_000
  return {
    calls,
    slept,
    options: {
      fetch: async (url: string, init: RequestInit) => {
        const call: Call = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)), at: clock }
        calls.push(call)
        return handler(call, calls.length)
      },
      sleep: async (ms: number) => {
        slept.push(ms)
        clock += ms
      },
      now: () => clock,
    },
  }
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

const page = (nodes: unknown[], next: string | null = null) => ({
  data: { events: { pageInfo: { hasNextPage: next !== null, endCursor: next }, edges: nodes.map((node) => ({ cursor: "c", node })) } },
})
/** A page of the older App.events: no end cursor, so the last edge carries the next page's. */
const legacyPage = (nodes: unknown[], next: string | null = null) => ({
  data: { app: { events: { pageInfo: { hasNextPage: next !== null }, edges: nodes.map((node, i) => ({ cursor: next && i === nodes.length - 1 ? next : `edge-${i}`, node })) } } },
})
const isLegacy = (call: Call) => call.body.query.includes("AppMetricsLegacyEvents")

/** `apps`: apps found by earlier runs. */
function memoryStore(apps: string[] = []) {
  const marks: Record<SyncPass, Date | null> = { core: null, earnings: null, legacy: null }
  const stored = new Map<string, ParsedEvent>()
  const store: SyncStore = {
    async watermarks() {
      return { ...marks }
    },
    async setWatermark(pass, at) {
      marks[pass] = at
    },
    async insertEvents(list) {
      let inserted = 0
      for (const e of list) {
        if (stored.has(e.id)) continue
        stored.set(e.id, e)
        inserted++
      }
      return { inserted }
    },
    async appGids() {
      const seen = [...stored.values()].flatMap((e) => (e.appGid ? [e.appGid] : []))
      return [...new Set([...apps, ...seen])].sort()
    },
  }
  return { store, stored, marks }
}

const APP = { __typename: "AppReference", id: "gid://shopify/App/1", name: "Badge Pro", apiKey: "key-1" }
let seq = 0
const node = (over: Record<string, unknown> = {}) => ({
  id: `gid://shopify/Event/${++seq}`,
  occurredAt: "2026-11-01T10:00:00Z",
  eventType: "RELATIONSHIP_INSTALLED",
  shop: { id: "gid://shopify/Shop/9", myshopifyDomain: "Acme.myshopify.com" },
  subject: APP,
  relationshipState: "INSTALLED",
  ...over,
})
/** A node of the older App.events, as Shopify documents it: no id, a charge instead. */
const legacyNode = (over: Record<string, unknown> = {}) => ({
  type: "SUBSCRIPTION_CHARGE_DECLINED",
  occurredAt: "2026-11-02T09:30:00Z",
  shop: { id: "gid://partners/Shop/9", myshopifyDomain: "Acme.myshopify.com" },
  charge: { id: "gid://shopify/AppSubscription/77", name: "Pro plan", test: false, amount: { amount: "19.99", currencyCode: "USD" } },
  ...over,
})
const client = (net: ReturnType<typeof fakeNetwork>) => createPartnerClient({ partnerId: "42", token: TOKEN, ...net.options })

// ---------------------------------------------------------------------------

describe("settings", () => {
  it("accepts a numeric Partner ID and a dated API version, nothing else", () => {
    expect(validatePartnerId("12345")).toBe(true)
    expect(validatePartnerId(" 12345 ")).toBe(true)
    for (const bad of ["", "abc", "12 34", "1".repeat(30), "../etc"]) expect(validatePartnerId(bad)).toBe(false)
    expect(validateApiVersion("2026-07")).toBe(true)
    expect(validateApiVersion("unstable")).toBe(true)
    for (const bad of ["latest", "2026", "2026-7", "2026-07/../x"]) expect(validateApiVersion(bad)).toBe(false)
  })

  it("refuses to build a client from a bad ID or version", () => {
    expect(() => createPartnerClient({ partnerId: "abc", token: "t" })).toThrow(PartnerApiError)
    expect(() => createPartnerClient({ partnerId: "1", token: "t", version: "nope" })).toThrow(PartnerApiError)
  })
})

describe("the query", () => {
  it("reads and never writes", () => {
    expect(EVENTS_QUERY).not.toMatch(/mutation/i)
  })
  it("asks for the largest page, oldest first, with the aliases the schema needs", () => {
    expect(EVENTS_QUERY).toMatch(/first: 250/)
    expect(EVENTS_QUERY).toMatch(/OCCURRED_AT_ASC/)
    expect(EVENTS_QUERY).toMatch(/relationshipState: state/)
    expect(EVENTS_QUERY).toMatch(/subscriptionState: state/)
    expect(EVENTS_QUERY).toMatch(/earningChargeId: chargeId/)
  })
  it("keeps earnings in a pass of their own", () => {
    expect(CORE_EVENT_TYPES.every((t) => !t.startsWith("EARNING_"))).toBe(true)
    expect(EARNING_EVENT_TYPES.every((t) => t.startsWith("EARNING_"))).toBe(true)
  })
})

describe("the query for the older App.events", () => {
  it("reads and never writes", () => {
    expect(LEGACY_EVENTS_QUERY).not.toMatch(/mutation/i)
  })
  it("asks for one app, 100 a page, and pages by the last edge's cursor", () => {
    expect(LEGACY_EVENTS_QUERY).toMatch(/app\(id: \$appId\)/)
    expect(LEGACY_EVENTS_QUERY).toMatch(/first: 100, after: \$cursor/)
    expect(LEGACY_EVENTS_QUERY).toMatch(/edges \{\s+cursor/)
    // PageInfo on this connection has no endCursor: asking for it fails the whole query.
    expect(LEGACY_EVENTS_QUERY).not.toMatch(/endCursor/)
  })
  it("reads only the billing screen, nothing the other passes read", () => {
    expect(LEGACY_EVENT_TYPES).toHaveLength(8)
    const others = new Set<string>([...CORE_EVENT_TYPES, ...EARNING_EVENT_TYPES])
    expect(LEGACY_EVENT_TYPES.filter((t) => others.has(t))).toEqual([])
  })
  it("names the app the way app(id:) expects", () => {
    expect(partnersAppId("gid://shopify/App/123")).toBe("gid://partners/App/123")
    expect(partnersAppId("gid://partners/App/123")).toBe("gid://partners/App/123")
    expect(partnersAppId("something else")).toBe("something else")
  })
})

describe("one request", () => {
  it("posts to the organization's endpoint with the token in Shopify's header", async () => {
    const net = fakeNetwork(() => reply({ data: { ok: 1 } }))
    const data = await client(net).query<{ ok: number }>("query { x }", { a: 1 })
    expect(data.ok).toBe(1)
    expect(net.calls[0].url).toBe("https://partners.shopify.com/42/api/2026-07/graphql.json")
    expect(net.calls[0].headers["X-Shopify-Access-Token"]).toBe(TOKEN)
    expect(net.calls[0].body).toMatchObject({ query: "query { x }", variables: { a: 1 } })
  })

  it("keeps calls at least 300 ms apart", async () => {
    const net = fakeNetwork(() => reply({ data: {} }))
    const c = client(net)
    for (let i = 0; i < 3; i++) await c.query("q", {})
    expect(net.calls[1].at - net.calls[0].at).toBeGreaterThanOrEqual(300)
    expect(net.calls[2].at - net.calls[1].at).toBeGreaterThanOrEqual(300)
  })

  it("waits as long as Retry-After says after a 429, then succeeds", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply({ errors: [{ message: "Too many requests" }] }, 429, { "retry-after": "2" }) : reply({ data: { done: true } })))
    const data = await client(net).query<{ done: boolean }>("q", {})
    expect(data.done).toBe(true)
    expect(net.slept).toContain(2000)
    expect(net.calls).toHaveLength(2)
  })

  it("retries a 5xx, and gives up after four tries", async () => {
    const flaky = fakeNetwork((_c, n) => (n < 3 ? reply("bad gateway", 502) : reply({ data: { done: true } })))
    expect(await client(flaky).query("q", {})).toEqual({ done: true })
    expect(flaky.calls).toHaveLength(3)

    const down = fakeNetwork(() => reply("down", 503))
    await expect(client(down).query("q", {})).rejects.toBeInstanceOf(PartnerApiError)
    expect(down.calls).toHaveLength(4)
  })

  it("retries a dropped connection", async () => {
    let n = 0
    const net = fakeNetwork(() => {
      if (++n < 3) throw new TypeError("fetch failed")
      return reply({ data: { done: true } })
    })
    expect(await client(net).query("q", {})).toEqual({ done: true })
    expect(n).toBe(3)
  })

  it("fails a 401 at once, and never lets the token into the message", async () => {
    const net = fakeNetwork(() => reply({ errors: [{ message: `Invalid access token ${TOKEN}` }] }, 401))
    const error = (await client(net).query("q", {}).catch((e: unknown) => e)) as PartnerApiError
    expect(error).toBeInstanceOf(PartnerApiError)
    expect(error.status).toBe(401)
    expect(error.message).not.toContain(TOKEN)
    expect(error.message).toContain("[token]")
    expect(net.calls).toHaveLength(1)
  })

  it("treats a GraphQL error sent with HTTP 200 as an error", async () => {
    const net = fakeNetwork(() => reply({ errors: [{ message: "Field 'x' doesn't exist" }], data: null }))
    await expect(client(net).query("q", {})).rejects.toThrow(/doesn't exist/)
    expect(net.calls).toHaveLength(1)
  })

  it("treats an answer that is not JSON as an error", async () => {
    const net = fakeNetwork(() => new Response("<html>", { status: 200 }))
    await expect(client(net).query("q", {})).rejects.toBeInstanceOf(PartnerApiError)
  })
})

describe("one event node", () => {
  it("reads an install, lower-casing the shop and keeping the whole node", () => {
    const n = node()
    const e = parseEventNode(n)!
    expect(e).toMatchObject({ type: "RELATIONSHIP_INSTALLED", state: "INSTALLED", shop: "acme.myshopify.com", appGid: APP.id, appName: "Badge Pro", appApiKey: "key-1" })
    expect(e.payload).toBe(n)
  })

  it("reads an uninstall's reason and the merchant's words", () => {
    const e = parseEventNode(node({ eventType: "RELATIONSHIP_UNINSTALLED", relationshipState: "UNINSTALLED", reason: "app_not_working", reasonDescription: "  The badge never showed  " }))!
    expect(e.reason).toBe("app_not_working")
    expect(e.reasonDescription).toBe("The badge never showed")
  })

  it("reads a subscription's plan, trial and price in cents", () => {
    const e = parseEventNode(
      node({
        eventType: "SUBSCRIPTION_CREATED",
        relationshipState: undefined,
        subscriptionState: "CREATED",
        plan: { handle: "pro", billingPeriod: "ANNUAL", trialDays: 7, prices: [{ __typename: "FlatRatePlanPrice", currencyCode: "USD", amount: "240.00" }] },
      }),
    )!
    expect(e).toMatchObject({ state: "CREATED", planHandle: "pro", billingPeriod: "ANNUAL", trialDays: 7, amountCents: 24000, currency: "USD" })
  })

  it("reads a charge, an earning with its fee, a refund's sign, and a credit", () => {
    const charge = parseEventNode(node({ eventType: "CHARGE_RECURRING", relationshipState: undefined, chargeId: "c1", amount: { amount: "24.99", currencyCode: "USD" }, planHandle: "pro" }))!
    expect(charge).toMatchObject({ amountCents: 2499, planHandle: "pro", chargeId: "c1" })

    const earning = parseEventNode(node({ eventType: "EARNING_CHARGE_RECURRING", relationshipState: undefined, earningChargeId: "c1", grossAmount: { amount: "24.99", currencyCode: "USD" }, netAmount: { amount: "24.24", currencyCode: "USD" }, shopifyFee: { amount: "0.75", currencyCode: "USD" } }))!
    expect(earning).toMatchObject({ grossCents: 2499, netCents: 2424, feeCents: 75, chargeId: "c1" })

    const refund = parseEventNode(node({ eventType: "EARNING_REFUND", relationshipState: undefined, grossAmount: { amount: "-24.99", currencyCode: "USD" }, netAmount: { amount: "-24.99", currencyCode: "USD" }, shopifyFee: { amount: "0", currencyCode: "USD" } }))!
    expect(refund.netCents).toBe(-2499)

    const credit = parseEventNode(node({ eventType: "CREDIT_APPLIED", relationshipState: undefined, status: "APPLIED", money: { amount: "5.00", currencyCode: "USD" } }))!
    expect(credit).toMatchObject({ state: "APPLIED", amountCents: 500 })
  })

  it("skips anything that is not a usable event, and never produces NaN", () => {
    expect(parseEventNode(null)).toBeNull()
    expect(parseEventNode({ eventType: "X", occurredAt: "2026-11-01T00:00:00Z" })).toBeNull()
    expect(parseEventNode(node({ occurredAt: "not a date" }))).toBeNull()
    expect(parseEventNode(node({ eventType: "CHARGE_RECURRING", amount: { amount: "abc" } }))!.amountCents).toBeNull()
  })
})

describe("one node of the older App.events", () => {
  it("reads a declined charge under the app it was read for, keeping the type as sent and the whole node", () => {
    const n = legacyNode()
    const e = parseLegacyEventNode(n, APP.id)!
    expect(e).toMatchObject({
      type: "SUBSCRIPTION_CHARGE_DECLINED",
      occurredAt: new Date("2026-11-02T09:30:00Z"),
      appGid: APP.id,
      appName: null,
      shop: "acme.myshopify.com",
      shopGid: "gid://partners/Shop/9",
      amountCents: 1999,
      currency: "USD",
      chargeId: "gid://shopify/AppSubscription/77",
      planHandle: null,
      state: null,
    })
    expect(e.payload).toBe(n)
    expect(e.payload.charge).toMatchObject({ name: "Pro plan", test: false })
  })

  it("reads a one-time charge and a usage cap the same way, and keeps the test flag", () => {
    const oneTime = parseLegacyEventNode(
      legacyNode({ type: "ONE_TIME_CHARGE_EXPIRED", charge: { id: "gid://shopify/AppPurchaseOneTime/5", name: "Setup", test: true, amount: { amount: "50.00", currencyCode: "USD" } } }),
      APP.id,
    )!
    expect(oneTime).toMatchObject({ type: "ONE_TIME_CHARGE_EXPIRED", amountCents: 5000, chargeId: "gid://shopify/AppPurchaseOneTime/5" })
    expect(oneTime.payload.charge).toMatchObject({ test: true })

    const cap = parseLegacyEventNode(legacyNode({ type: "SUBSCRIPTION_APPROACHING_CAPPED_AMOUNT" }), APP.id)!
    expect(cap).toMatchObject({ type: "SUBSCRIPTION_APPROACHING_CAPPED_AMOUNT", amountCents: 1999 })
  })

  it("gives the same event the same id on every read, and another event another id", () => {
    const id = parseLegacyEventNode(legacyNode(), APP.id)!.id
    expect(id).toMatch(/^legacy:[0-9a-f]{64}$/)
    expect(parseLegacyEventNode(legacyNode(), APP.id)!.id).toBe(id)
    // The same instant and shop written differently is the same event.
    expect(parseLegacyEventNode(legacyNode({ occurredAt: "2026-11-02T09:30:00.000Z", shop: { id: "gid://partners/Shop/9", myshopifyDomain: "acme.myshopify.com" } }), APP.id)!.id).toBe(id)

    const others = [
      legacyNode({ type: "SUBSCRIPTION_CHARGE_ACCEPTED" }),
      legacyNode({ occurredAt: "2026-11-02T09:30:01Z" }),
      legacyNode({ shop: { id: "gid://partners/Shop/10", myshopifyDomain: "other.myshopify.com" } }),
      legacyNode({ charge: { ...legacyNode().charge, id: "gid://shopify/AppSubscription/78" } }),
    ].map((n) => parseLegacyEventNode(n, APP.id)!.id)
    expect(new Set([id, ...others]).size).toBe(5)
  })

  it("reads the shop's domain even if Shopify sends it as an address", () => {
    const e = parseLegacyEventNode(legacyNode({ shop: { id: "gid://partners/Shop/9", myshopifyDomain: "https://Acme.myshopify.com/" } }), APP.id)!
    expect(e.shop).toBe("acme.myshopify.com")
    expect(e.id).toBe(parseLegacyEventNode(legacyNode(), APP.id)!.id)
  })

  it("skips anything that is not a usable billing screen event, and never produces NaN", () => {
    expect(parseLegacyEventNode(null, APP.id)).toBeNull()
    expect(parseLegacyEventNode({ occurredAt: "2026-11-01T00:00:00Z" }, APP.id)).toBeNull()
    expect(parseLegacyEventNode(legacyNode({ occurredAt: "not a date" }), APP.id)).toBeNull()
    // Asked for the billing screen only: an install read here would be counted twice.
    expect(parseLegacyEventNode(legacyNode({ type: "RELATIONSHIP_INSTALLED" }), APP.id)).toBeNull()
    expect(parseLegacyEventNode(legacyNode({ type: "SUBSCRIPTION_CHARGE_ACTIVATED" }), APP.id)).toBeNull()
    expect(parseLegacyEventNode(legacyNode({ charge: { id: "c", amount: { amount: "abc" } } }), APP.id)!.amountCents).toBeNull()
    expect(parseLegacyEventNode(legacyNode({ charge: null, shop: null }), APP.id)).toMatchObject({ shop: null, chargeId: null, amountCents: null })
  })
})

describe("the sync", () => {
  const backfillFrom = new Date("2026-06-01T00:00:00Z")

  it("stores the events, learns the apps, and moves every watermark to now", async () => {
    const net = fakeNetwork((c, n) =>
      isLegacy(c) ? reply(legacyPage([])) : n === 1 ? reply(page([node({ id: "e1" }), node({ id: "e2", eventType: "CHARGE_RECURRING", amount: { amount: "24.99", currencyCode: "USD" } })])) : reply(page([])),
    )
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result).toMatchObject({ ok: true, inserted: 2, appsSeen: 1, earningsError: null, legacyError: null })
    expect([...mem.stored.keys()]).toEqual(["e1", "e2"])
    expect(mem.marks).toEqual({ core: NOW, earnings: NOW, legacy: NOW })
  })

  it("asks for the core types first and earnings second, over the whole window", async () => {
    const net = fakeNetwork(() => reply(page([])))
    await syncConnection({ client: client(net), store: memoryStore().store, backfillFrom, now: NOW })
    const [core, earnings] = net.calls.map((c) => c.body.variables.filter)
    expect(core.eventTypes).toEqual([...CORE_EVENT_TYPES])
    expect(earnings.eventTypes).toEqual([...EARNING_EVENT_TYPES])
    expect(core).toMatchObject({ subjectType: "APP", occurredAtMin: "2026-06-01T00:00:00.000Z", occurredAtMax: NOW.toISOString() })
    expect(core.subjectId).toBeUndefined()
  })

  it("follows the cursor to the next page", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply(page([node({ id: "p1" })], "cursor-1")) : n === 2 ? reply(page([node({ id: "p2" })])) : reply(page([]))))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.inserted).toBe(2)
    expect(net.calls[1].body.variables.cursor).toBe("cursor-1")
  })

  it("starts three days before the watermark on a later run", async () => {
    const net = fakeNetwork(() => reply(page([])))
    const mem = memoryStore()
    mem.marks.core = new Date("2026-11-20T00:00:00.000Z")
    mem.marks.earnings = new Date("2026-11-20T00:00:00.000Z")
    await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(net.calls[0].body.variables.filter.occurredAtMin).toBe("2026-11-17T00:00:00.000Z")
  })

  it("stores an event read twice once", async () => {
    const net = fakeNetwork(() => reply(page([node({ id: "same" })])))
    const mem = memoryStore()
    await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    const again = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(mem.stored.size).toBe(1)
    expect(again.inserted).toBe(0)
  })

  it("reads each listed app on its own when apps are listed", async () => {
    const net = fakeNetwork(() => reply(page([])))
    await syncConnection({ client: client(net), store: memoryStore().store, backfillFrom, appGids: ["gid://shopify/App/1", "gid://shopify/App/2"], now: NOW })
    const subjects = net.calls.map((c) => c.body.variables.filter.subjectId)
    expect(subjects).toEqual(["gid://shopify/App/1", "gid://shopify/App/2", "gid://shopify/App/1", "gid://shopify/App/2"])
  })

  it("skips events with no app and nodes it cannot read, and keeps the rest", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply(page([{ junk: true }, node({ id: "no-app", subject: null }), node({ id: "good" })])) : reply(page([]))))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.ok).toBe(true)
    expect([...mem.stored.keys()]).toEqual(["good"])
  })

  it("keeps a failing earnings pass from failing the run, and does not move its watermark", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply(page([node({ id: "c1" })])) : reply({ errors: [{ message: "Access denied" }] })))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.ok).toBe(true)
    expect(result.earningsError).toMatch(/Access denied/)
    expect(mem.marks.core).toEqual(NOW)
    expect(mem.marks.earnings).toBeNull()
  })

  it("fails the run on a core error, moves no watermark, and keeps the token out of the message", async () => {
    const net = fakeNetwork(() => reply({ errors: [{ message: `Invalid access token ${TOKEN}` }] }, 401))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/401/)
    expect(result.error).not.toContain(TOKEN)
    expect(mem.marks.core).toBeNull()
  })

  it("keeps what a failed window stored, but does not call the window done", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply(page([node({ id: "k1" })], "next")) : reply({ errors: [{ message: "boom" }] }, 400)))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.ok).toBe(false)
    expect(mem.stored.has("k1")).toBe(true)
    expect(mem.marks.core).toBeNull()
  })

  it("reads a long backfill in windows under the 365 day cap, edge to edge", async () => {
    const net = fakeNetwork(() => reply(page([])))
    const long = new Date(NOW.getTime() - 400 * 86_400_000)
    await syncConnection({ client: client(net), store: memoryStore().store, backfillFrom: long, now: NOW })
    const core = net.calls.slice(0, 2).map((c) => c.body.variables.filter as { occurredAtMin: string; occurredAtMax: string })
    const days = (f: { occurredAtMin: string; occurredAtMax: string }) => (Date.parse(f.occurredAtMax) - Date.parse(f.occurredAtMin)) / 86_400_000
    expect(net.calls).toHaveLength(4)
    expect(days(core[0])).toBeLessThanOrEqual(300)
    expect(days(core[1])).toBeLessThanOrEqual(300)
    expect(core[0].occurredAtMax).toBe(core[1].occurredAtMin)
    expect(core[1].occurredAtMax).toBe(NOW.toISOString())
  })

  it("stops on a next page with no cursor, and on paging that never ends", async () => {
    const noCursor = fakeNetwork(() => reply({ data: { events: { pageInfo: { hasNextPage: true, endCursor: null }, edges: [] } } }))
    expect((await syncConnection({ client: client(noCursor), store: memoryStore().store, backfillFrom, now: NOW })).error).toMatch(/cursor/)

    const endless = fakeNetwork(() => reply(page([], "again")))
    const result = await syncConnection({ client: client(endless), store: memoryStore().store, backfillFrom, now: NOW, maxPages: 3 })
    expect(result.error).toMatch(/paging/)
    expect(endless.calls).toHaveLength(3)
  })

  it("never puts the token in a request body", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([]) : page([])))
    await syncConnection({ client: client(net), store: memoryStore([APP.id]).store, backfillFrom, now: NOW })
    expect(net.calls.some(isLegacy)).toBe(true)
    for (const c of net.calls) expect(JSON.stringify(c.body)).not.toContain(TOKEN)
  })
})

describe("the billing screen pass (the older App.events)", () => {
  const backfillFrom = new Date("2026-06-01T00:00:00Z")
  const APP_2 = "gid://shopify/App/2"
  const APP_3 = "gid://shopify/App/3"
  const legacyCalls = (net: ReturnType<typeof fakeNetwork>) => net.calls.filter(isLegacy).map((c) => c.body.variables)

  it("runs last, reading each app found so far through app(id:), for the billing screen types, over the whole window", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([]) : page([])))
    const mem = memoryStore([APP.id, APP_2])
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })

    expect(net.calls.map(isLegacy)).toEqual([false, false, true, true])
    expect(legacyCalls(net)).toEqual([
      { appId: "gid://partners/App/1", types: [...LEGACY_EVENT_TYPES], occurredAtMin: "2026-06-01T00:00:00.000Z", occurredAtMax: NOW.toISOString(), cursor: null },
      { appId: "gid://partners/App/2", types: [...LEGACY_EVENT_TYPES], occurredAtMin: "2026-06-01T00:00:00.000Z", occurredAtMax: NOW.toISOString(), cursor: null },
    ])
    expect(result.legacyError).toBeNull()
    expect(mem.marks.legacy).toEqual(NOW)
  })

  it("reads the apps the core pass finds in the same run", async () => {
    const net = fakeNetwork((c, n) => (isLegacy(c) ? reply(legacyPage([])) : n === 1 ? reply(page([node({ id: "i1" })])) : reply(page([]))))
    await syncConnection({ client: client(net), store: memoryStore().store, backfillFrom, now: NOW })
    expect(legacyCalls(net).map((v) => v.appId)).toEqual(["gid://partners/App/1"])
  })

  it("reads only the chosen apps when apps are chosen", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([]) : page([])))
    await syncConnection({ client: client(net), store: memoryStore([APP.id, APP_2, APP_3]).store, backfillFrom, appGids: [APP.id, APP_3], now: NOW })
    expect(legacyCalls(net).map((v) => v.appId)).toEqual(["gid://partners/App/1", "gid://partners/App/3"])
  })

  it("files the events under the app as stored, and follows the last edge's cursor to the next page", async () => {
    const declined = legacyNode()
    const expired = legacyNode({ type: "SUBSCRIPTION_CHARGE_EXPIRED", occurredAt: "2026-11-03T10:00:00Z" })
    const accepted = legacyNode({ type: "ONE_TIME_CHARGE_ACCEPTED", occurredAt: "2026-11-04T10:00:00Z", charge: { id: "gid://shopify/AppPurchaseOneTime/5", name: "Setup", test: true, amount: { amount: "50.00", currencyCode: "USD" } } })
    let legacy = 0
    const net = fakeNetwork((c) => (!isLegacy(c) ? reply(page([])) : ++legacy === 1 ? reply(legacyPage([declined, expired], "page-2")) : reply(legacyPage([accepted]))))
    const mem = memoryStore([APP.id])
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })

    expect(legacyCalls(net).map((v) => v.cursor)).toEqual([null, "page-2"])
    expect(result).toMatchObject({ ok: true, inserted: 3, legacyError: null })
    const stored = [...mem.stored.values()]
    expect(stored.map((e) => e.type)).toEqual(["SUBSCRIPTION_CHARGE_DECLINED", "SUBSCRIPTION_CHARGE_EXPIRED", "ONE_TIME_CHARGE_ACCEPTED"])
    expect(stored.every((e) => e.appGid === APP.id && e.id.startsWith("legacy:"))).toBe(true)
  })

  it("starts three days before its own watermark", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([]) : page([])))
    const mem = memoryStore([APP.id])
    mem.marks.core = new Date("2026-11-20T00:00:00.000Z")
    mem.marks.earnings = new Date("2026-11-20T00:00:00.000Z")
    mem.marks.legacy = new Date("2026-11-10T00:00:00.000Z")
    await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(net.calls[0].body.variables.filter.occurredAtMin).toBe("2026-11-17T00:00:00.000Z")
    expect(legacyCalls(net)[0].occurredAtMin).toBe("2026-11-07T00:00:00.000Z")
    expect(mem.marks.legacy).toEqual(NOW)
  })

  it("stores a billing screen event read twice once, across the overlap of two runs", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([legacyNode({ occurredAt: "2026-11-21T09:00:00Z" })]) : page([])))
    const mem = memoryStore([APP.id])
    const first = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    const again = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: new Date(NOW.getTime() + 3_600_000) })
    expect(first.inserted).toBe(1)
    expect(again.inserted).toBe(0)
    expect(mem.stored.size).toBe(1)
  })

  it("reads a long backfill in windows edge to edge, app by app", async () => {
    const net = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([]) : page([])))
    const long = new Date(NOW.getTime() - 400 * 86_400_000)
    await syncConnection({ client: client(net), store: memoryStore([APP.id, APP_2]).store, backfillFrom: long, now: NOW })
    const calls = legacyCalls(net)
    const days = (v: Variables) => (Date.parse(v.occurredAtMax!) - Date.parse(v.occurredAtMin!)) / 86_400_000
    expect(calls.map((v) => v.appId)).toEqual(["gid://partners/App/1", "gid://partners/App/2", "gid://partners/App/1", "gid://partners/App/2"])
    expect(days(calls[0])).toBeLessThanOrEqual(300)
    expect(calls[0].occurredAtMin).toBe(long.toISOString())
    expect(calls[0].occurredAtMax).toBe(calls[2].occurredAtMin)
    expect(calls[2].occurredAtMax).toBe(NOW.toISOString())
  })

  it("leaves the core and earnings results intact when it fails", async () => {
    const net = fakeNetwork((c, n) => {
      if (isLegacy(c)) return reply({ errors: [{ message: "Field 'events' doesn't exist on type 'App'" }] })
      if (n === 1) return reply(page([node({ id: "core-1" })]))
      return reply(page([node({ id: "earn-1", eventType: "EARNING_CHARGE_RECURRING", relationshipState: undefined, grossAmount: { amount: "10.00", currencyCode: "USD" } })]))
    })
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result).toMatchObject({ ok: true, inserted: 2, appsSeen: 1, earningsError: null })
    expect(result.error).toBeUndefined()
    expect(result.legacyError).toMatch(/doesn't exist/)
    expect([...mem.stored.keys()]).toEqual(["core-1", "earn-1"])
    expect(mem.marks).toEqual({ core: NOW, earnings: NOW, legacy: null })
  })

  it("keeps what a failed window stored, but does not move its watermark", async () => {
    let legacy = 0
    const net = fakeNetwork((c) => (!isLegacy(c) ? reply(page([])) : ++legacy === 1 ? reply(legacyPage([legacyNode()], "next")) : reply("bad gateway", 400)))
    const mem = memoryStore([APP.id])
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result.ok).toBe(true)
    expect(result.legacyError).toMatch(/400/)
    expect(mem.stored.size).toBe(1)
    expect(mem.marks.legacy).toBeNull()
  })

  it("still runs when the earnings pass fails, and not at all when the core pass does", async () => {
    const noEarnings = fakeNetwork((c, n) => (isLegacy(c) ? reply(legacyPage([legacyNode()])) : n === 1 ? reply(page([])) : reply({ errors: [{ message: "Access denied" }] })))
    const mem = memoryStore([APP.id])
    const result = await syncConnection({ client: client(noEarnings), store: mem.store, backfillFrom, now: NOW })
    expect(result).toMatchObject({ ok: true, inserted: 1, legacyError: null })
    expect(result.earningsError).toMatch(/Access denied/)
    expect(mem.marks).toEqual({ core: NOW, earnings: null, legacy: NOW })

    const noCore = fakeNetwork(() => reply({ errors: [{ message: "boom" }] }, 400))
    const failed = memoryStore([APP.id])
    expect((await syncConnection({ client: client(noCore), store: failed.store, backfillFrom, now: NOW })).ok).toBe(false)
    expect(noCore.calls.some(isLegacy)).toBe(false)
    expect(failed.marks.legacy).toBeNull()
  })

  it("fails on an app Shopify does not find, on a next page with no cursor, and on paging that never ends", async () => {
    const missing = fakeNetwork((c) => reply(isLegacy(c) ? { data: { app: null } } : page([])))
    const notFound = await syncConnection({ client: client(missing), store: memoryStore([APP.id]).store, backfillFrom, now: NOW })
    expect(notFound.legacyError).toMatch(/found no app gid:\/\/partners\/App\/1/)

    const noCursor = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([], "lost") : page([])))
    expect((await syncConnection({ client: client(noCursor), store: memoryStore([APP.id]).store, backfillFrom, now: NOW })).legacyError).toMatch(/cursor/)

    const endless = fakeNetwork((c) => reply(isLegacy(c) ? legacyPage([legacyNode()], "again") : page([])))
    const result = await syncConnection({ client: client(endless), store: memoryStore([APP.id]).store, backfillFrom, now: NOW, maxPages: 3 })
    expect(result.legacyError).toMatch(/paging/)
    expect(endless.calls.filter(isLegacy)).toHaveLength(3)
  })

  it("asks nothing when no app has been found, and moves on", async () => {
    const net = fakeNetwork(() => reply(page([])))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(net.calls.some(isLegacy)).toBe(false)
    expect(result.legacyError).toBeNull()
    expect(mem.marks.legacy).toEqual(NOW)
  })
})
