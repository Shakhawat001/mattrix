import { describe, expect, it } from "vitest"
import { createPartnerClient, PartnerApiError, validateApiVersion, validatePartnerId } from "@/lib/partner/client"
import { parseEventNode, type ParsedEvent } from "@/lib/partner/parse"
import { CORE_EVENT_TYPES, EARNING_EVENT_TYPES, EVENTS_QUERY } from "@/lib/partner/query"
import { syncConnection, type SyncStore } from "@/lib/partner/sync"

const TOKEN = "tok_secret_123"
const NOW = new Date("2026-11-22T12:00:00Z")

// ---------------------------------------------------------------------------
// Fakes: a network that records calls, a clock that only moves when told, a store in memory
// ---------------------------------------------------------------------------

type Call = { url: string; headers: Record<string, string>; body: { query: string; variables: { filter: Record<string, unknown>; cursor: string | null } }; at: number }

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

function memoryStore() {
  const marks: { core: Date | null; earnings: Date | null } = { core: null, earnings: null }
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

describe("the sync", () => {
  const backfillFrom = new Date("2026-06-01T00:00:00Z")

  it("stores the events, learns the apps, and moves both watermarks to now", async () => {
    const net = fakeNetwork((_c, n) => (n === 1 ? reply(page([node({ id: "e1" }), node({ id: "e2", eventType: "CHARGE_RECURRING", amount: { amount: "24.99", currencyCode: "USD" } })])) : reply(page([]))))
    const mem = memoryStore()
    const result = await syncConnection({ client: client(net), store: mem.store, backfillFrom, now: NOW })
    expect(result).toMatchObject({ ok: true, inserted: 2, appsSeen: 1, earningsError: null })
    expect([...mem.stored.keys()]).toEqual(["e1", "e2"])
    expect(mem.marks.core).toEqual(NOW)
    expect(mem.marks.earnings).toEqual(NOW)
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
    const net = fakeNetwork(() => reply(page([])))
    await syncConnection({ client: client(net), store: memoryStore().store, backfillFrom, now: NOW })
    for (const c of net.calls) expect(JSON.stringify(c.body)).not.toContain(TOKEN)
  })
})
