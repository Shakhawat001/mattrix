import { randomBytes } from "node:crypto"
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { POST } from "@/app/api/mcp/route"
import { addRetention, bucketSeries, cohortRetention, kpisFor, seriesByApp } from "@/lib/analytics/aggregate"
import { getAtRisk } from "@/lib/analytics/at-risk"
import { getDataHealth } from "@/lib/analytics/data-health"
import { addExcludedShop, removeExcludedShop } from "@/lib/analytics/excluded-shops"
import { AT_RISK_METRICS, METRICS, type MetricId } from "@/lib/analytics/metrics-registry"
import { getMrrMovers } from "@/lib/analytics/mrr-movers"
import { getDayRows, getExplanations, getLifetimeStats, getReasons, getRetention, getStays, getTrialStats, listApps, listShops } from "@/lib/analytics/queries"
import { addDays, previousRange, type Range } from "@/lib/analytics/range"
import { todayIn } from "@/lib/time-zone"
import { rebuildApp, rebuildStaleApps } from "@/lib/analytics/rebuild"
import { getRevenueCohorts } from "@/lib/analytics/revenue-cohorts"
import { getShopTimeline } from "@/lib/analytics/shop-timeline"
import { getShopTotals } from "@/lib/analytics/shop-totals"
import { getWinBack } from "@/lib/analytics/win-back"
import { createApiToken } from "@/lib/auth/api-tokens"
import { getDatabase, type Database } from "@/lib/db/client"
import { apps, connections, events, syncRuns } from "@/lib/db/schema"
import { generateDemoEvents } from "@/lib/demo/generate"
import { resetEnvCache } from "@/lib/env"
import { RANGE_METRIC_IDS } from "@/lib/mcp/metrics"
import { metricValue, percent, shopAlias } from "@/lib/mcp/output"
import { TOOLS } from "@/lib/mcp/server"
import type { ParsedEvent } from "@/lib/partner/parse"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase, TEST_DATABASE_URL } from "../helpers/db"

// Every tool on demo data, through the route as an agent calls it, against the functions the
// dashboard's pages call for the same apps and range: the numbers must be the same.

const SECRET = "mcp-tools-test-session-secret-0123456789-abcdef"
const DAY = 86_400_000
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Answer = any

/** A tools/call as a client on the 2026-07-28 revision sends it. The result, which is an error when isError is set, and the whole response body as sent. */
async function send(name: string, args: Record<string, unknown>, token: string): Promise<{ isError: boolean; text: string; answer: Answer; raw: string }> {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name }
  const response = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }))
  expect(response.status).toBe(200)
  const raw = await response.text()
  const { result } = JSON.parse(raw)
  return { isError: result.isError === true, text: result.content[0].text, answer: result.structuredContent, raw }
}

describe.skipIf(!hasDatabase)("MCP tools on demo data (Postgres)", () => {
  let database: Database
  let ids: string[]
  let plain: string
  let hidden: string
  const today = todayIn("UTC")
  const alias = (domain: string) => shopAlias(SECRET, domain)

  async function call(name: string, args: Record<string, unknown> = {}, token = plain): Promise<Answer> {
    const { isError, text, answer } = await send(name, args, token)
    if (isError) throw new Error(`${name} failed: ${text}`)
    return answer
  }
  async function refusal(name: string, args: Record<string, unknown>, token = plain): Promise<string> {
    const { isError, text } = await send(name, args, token)
    expect(isError, text).toBe(true)
    return text
  }

  /** The numbers the dashboard's pages show for these apps and range: loadDashboard's reads and sums. */
  async function dashboard(appIds: string[], range: Range, compared: Range | null = null) {
    const db = database.db
    const from = compared && compared.from < range.from ? compared.from : range.from
    const rows = await getDayRows(db, appIds, { from, to: range.to })
    const together = async (r: Range) => addRetention([...(await getRetention(db, appIds, r, "UTC")).values()])
    return { rows, kpis: kpisFor(rows, range, await together(range)), compared: compared ? kpisFor(rows, compared, await together(compared)) : null }
  }

  const valueOf = (id: MetricId, value: number | null) => metricValue(value, METRICS[id].format)

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: TEST_DATABASE_URL,
      DASHBOARD_USER: "owner",
      DASHBOARD_PASSWORD: "a-long-test-password",
      SESSION_SECRET: SECRET,
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    })
    resetEnvCache()
    database = await openTestDatabase()
    await clearAll(database)

    const now = new Date()
    const [c] = await database.db
      .insert(connections)
      .values({ label: "Demo organization", partnerId: "0", tokenCiphertext: "x", tokenHint: "demo", backfillFrom: new Date(now.getTime() - 500 * DAY), isDemo: true, paused: true, lastOkAt: now, lastRunAt: now })
      .returning({ id: connections.id })
    await insertEvents(database.db, c.id, generateDemoEvents({ now, days: 400, seed: 5 }).events)
    await rebuildStaleApps(database.db, now)
    // Tables filled a moment ago have no planner statistics yet, and the shops query crawls without
    // them. A real database's autovacuum gathers them on its own.
    await database.sql`analyze`
    ids = (await listApps(database.db)).map((a) => a.id)

    const token = async (hideShops: boolean) => {
      const created = await createApiToken(database.db, SECRET, { name: hideShops ? "hides shops" : "shows shops", expiresInDays: null, hideShops })
      if (!created.ok) throw new Error("expected the token to be created")
      return created.token
    }
    plain = await token(false)
    hidden = await token(true)
  })

  afterAll(async () => {
    await database.close()
    await getDatabase().close()
  })

  describe("get_metrics", () => {
    it("returns the overview's numbers for every app together, equal to the dashboard's", async () => {
      expect(ids).toHaveLength(3)
      const answer = await call("get_metrics")
      const range = { from: addDays(today, -29), to: today }
      expect(answer.range).toEqual(range)
      expect(answer.compared_range).toBeUndefined()
      expect(answer.notes).toContain("Demo organization holds demo data made up by the seed-demo command. None of it is real.")
      expect(answer.data.apps.map((a: Answer) => a.id).sort()).toEqual([...ids].sort())
      expect(answer.data.metrics.map((m: Answer) => m.id)).toEqual(["mrr", "netNewMrr", "activeSubs", "activeInstalls", "installs", "uninstalls", "nrr", "subChurnRate", "trialConversion", "charged"])

      const { kpis } = await dashboard(ids, range)
      expect(kpis.mrr).toBeGreaterThan(0)
      for (const m of answer.data.metrics) {
        expect(m.value, m.id).toEqual(valueOf(m.id, kpis[m.id as MetricId]))
        expect(m).not.toHaveProperty("previous")
        expect(m.definition).toBe(METRICS[m.id as MetricId].description)
      }
    })

    it("serves every metric in the registry for one app, compared with the period before", async () => {
      const range = { from: addDays(today, -59), to: addDays(today, -5) }
      const answer = await call("get_metrics", { app_ids: [ids[1]], ...range, compare: "previous_period", metrics: RANGE_METRIC_IDS })
      expect(answer.compared_range).toEqual(previousRange(range))
      const { kpis, compared } = await dashboard([ids[1]], range, previousRange(range))
      expect(answer.data.metrics).toHaveLength(Object.keys(METRICS).length)
      for (const m of answer.data.metrics) {
        expect(m.value, m.id).toEqual(valueOf(m.id, kpis[m.id as MetricId]))
        expect(m.previous, m.id).toEqual(valueOf(m.id, compared![m.id as MetricId]))
        if (m.value !== null && m.previous !== null) expect(m.change, m.id).toHaveProperty("better")
      }
    })

    it("says when the range, or the range it is compared with, starts before the data", async () => {
      const earliest = (await getDayRows(database.db, ids, { from: "2000-01-01", to: today })).reduce((min, r) => (r.date < min ? r.date : min), today)
      const before = `The data of these apps starts on ${earliest}. Nothing before that day was read, so the part of the range before it is empty.`
      const comparedBefore = `The compared range starts before the data of these apps does, on ${earliest}, so the previous values leave out what happened before that day.`
      expect((await call("get_metrics", { from: addDays(earliest, -10), to: today })).notes).toContain(before)
      expect((await call("get_metrics", { preset: "last_12_months", compare: "previous_year" })).notes).toContain(comparedBefore)
      expect((await call("get_metrics", { preset: "last_30_days", compare: "previous_period" })).notes.filter((n: string) => n === before || n === comparedBefore)).toEqual([])
    })

    it("refuses an app that is not visible, and a metric it does not know", async () => {
      expect(await refusal("get_metrics", { app_ids: ["00000000-0000-4000-8000-000000000000"] })).toBe("Unknown app id: 00000000-0000-4000-8000-000000000000. list_apps gives the ids.")
      expect(await refusal("get_metrics", { metrics: ["nope"] })).toContain("Input validation error")
    })
  })

  describe("get_timeseries", () => {
    it("draws what the dashboard's charts draw, the apps together by week", async () => {
      const range = { from: addDays(today, -89), to: today }
      const answer = await call("get_timeseries", { ...range, granularity: "week", metrics: ["mrr", "activeInstalls", "installs", "uninstalls", "newMrr", "charged"] })
      const series = bucketSeries(await getDayRows(database.db, ids, range), range, "week")
      expect(answer.data.granularity).toBe("week")
      expect(answer.data.points.map((p: Answer) => p.bucket)).toEqual(series.map((p) => p.bucket))
      expect(answer.data.points[0].from).toBe(range.from)
      expect(answer.data.points.at(-1).to).toBe(today)
      answer.data.points.forEach((p: Answer, i: number) => {
        const s = series[i]
        expect([p.values.mrr.cents, p.values.activeInstalls.count, p.values.installs.count, p.values.uninstalls.count, p.values.newMrr.cents, p.values.charged.cents], p.bucket).toEqual([
          s.mrrCents,
          s.activeInstalls,
          s.installs,
          s.uninstalls,
          s.newMrrCents,
          s.chargedCents,
        ])
      })
    })

    it("draws each app on its own, by day, as the charts by app do", async () => {
      const range = { from: addDays(today, -20), to: today }
      const answer = await call("get_timeseries", { ...range, granularity: "day", metrics: ["mrr", "installs"], per_app: true })
      const rows = await getDayRows(database.db, ids, range)
      const mrr = seriesByApp(rows, range, "day", "mrrCents")
      const installs = seriesByApp(rows, range, "day", "installs")
      expect(answer.data.by_app.map((s: Answer) => s.app_id).sort()).toEqual([...ids].sort())
      for (const s of answer.data.by_app) {
        expect(s.points.map((p: Answer) => p.values.mrr.cents)).toEqual(mrr.map((b) => b.values[s.app_id] ?? 0))
        expect(s.points.map((p: Answer) => p.values.installs.count)).toEqual(installs.map((b) => b.values[s.app_id] ?? 0))
      }
    })

    it("works out a rate at each point the way get_metrics works it out for the point's days", async () => {
      const metrics = ["nrr", "subChurnRate", "ltv", "mrr"]
      const answer = await call("get_timeseries", { preset: "last_90_days", granularity: "month", metrics })
      expect(answer.data.points.length).toBeGreaterThanOrEqual(3)
      for (const p of answer.data.points) {
        const one = await call("get_metrics", { from: p.from, to: p.to, metrics })
        expect(one.data.metrics.map((m: Answer) => m.value), p.bucket).toEqual(metrics.map((id) => p.values[id]))
      }
    })

    it("refuses an answer too long to read", async () => {
      expect(await refusal("get_timeseries", { preset: "last_12_months", granularity: "day", metrics: ["mrr", "installs", "uninstalls", "activeSubs", "charged"] })).toContain("more than 1,500")
      expect(await refusal("get_timeseries", { preset: "last_12_months", granularity: "day", metrics: ["nrr"] })).toContain("at most 100 points")
    })
  })

  describe("explain_mrr_change", () => {
    it("gives the dashboard's MRR movement and the largest moves behind each part", async () => {
      const range = { from: addDays(today, -89), to: today }
      const answer = await call("explain_mrr_change", { ...range, limit: 3 })
      const { kpis } = await dashboard(ids, range)
      const { moves } = await getMrrMovers(database.db, ids, range, "UTC")
      expect(answer.data.mrr_at_start.cents).toBe(kpis.mrrStart)
      expect(answer.data.mrr_at_end.cents).toBe(kpis.mrr)
      expect(answer.data.net_new_mrr.cents).toBe(kpis.mrr - kpis.mrrStart)

      for (const [kind, metric] of [["new", "newMrr"], ["expansion", "expansionMrr"], ["contraction", "contractionMrr"], ["churned", "churnedMrr"]] as const) {
        const part = answer.data.movements[kind]
        const all = moves.filter((m) => m.kind === kind)
        expect(part.mrr.cents, kind).toBe(kpis[metric])
        expect(part.moves.count, kind).toBe(all.length)
        expect(part.largest.length, kind).toBe(Math.min(3, all.length))
        const amounts = part.largest.map((m: Answer) => m.mrr.cents)
        expect(amounts, kind).toEqual([...amounts].sort((a, b) => b - a))
        if (all.length > 0) expect(amounts[0], kind).toBe(Math.max(...all.map((m) => m.amountCents)))
      }
      expect(answer.data.movements.new.moves.count).toBeGreaterThan(3)
      expect(answer.notes).toContain("Each list holds the 3 largest moves of its movement, and moves counts them all. Ask for up to 50, or a shorter range, to see more.")
    })
  })

  describe("get_churn", () => {
    it("returns the churn page: numbers, causes, reasons, comments, lifetimes and win-back, equal to the dashboard's", async () => {
      const range = { from: addDays(today, -89), to: today }
      const answer = await call("get_churn", { ...range, compare: "previous_period", comments_limit: 3, returns_limit: 2 })
      const { kpis, compared } = await dashboard(ids, range, previousRange(range))
      for (const m of [...answer.data.metrics, ...answer.data.by_cause]) {
        expect(m.value, m.id).toEqual(valueOf(m.id, kpis[m.id as MetricId]))
        expect(m.previous, m.id).toEqual(valueOf(m.id, compared![m.id as MetricId]))
      }
      expect(answer.data.by_cause.map((m: Answer) => m.id)).toContain("churnedMrrMerchantLeft")

      const reasons = await getReasons(database.db, ids, range, "UTC")
      expect(answer.data.reasons.map((r: Answer) => [r.reason, r.uninstalls.count])).toEqual(reasons.map((r) => [r.reason, r.count]))

      const comments = await getExplanations(database.db, ids, range, "UTC", 4)
      expect(comments.length).toBe(4)
      expect(answer.data.comments.more).toBe(true)
      expect(answer.data.comments.list.map((c: Answer) => [c.shop, c.merchant_text_untrusted])).toEqual(comments.slice(0, 3).map((c) => [c.shop, c.text]))

      const life = await getLifetimeStats(database.db, ids, range, "UTC")
      expect(answer.data.install_lifetime).toMatchObject({ uninstalled: { count: life.ended }, still_installed: { count: life.open } })
      expect(answer.data.install_lifetime.lasted.reduce((sum: number, b: Answer) => sum + b.shops.count, 0)).toBe(life.ended)

      const winBack = await getWinBack(database.db, ids, range, "UTC", 2)
      expect(answer.data.win_back.left.count).toBe(winBack.left)
      expect(answer.data.win_back.metrics.map((m: Answer) => m.value)).toEqual([valueOf("installs", winBack.returned), metricValue(winBack.rate, "percent"), metricValue(winBack.medianDays, "days")])
      expect(answer.data.win_back.latest_returns.map((r: Answer) => r.shop)).toEqual(winBack.recent.map((r) => r.shop))
    })
  })

  describe("get_trials", () => {
    it("returns the trial numbers, the trials that started in the range, and the open trials behind In trial", async () => {
      const range = { from: addDays(today, -59), to: today }
      const answer = await call("get_trials", { ...range, limit: 3 })
      const { kpis } = await dashboard(ids, range)
      for (const m of answer.data.metrics) expect(m.value, m.id).toEqual(valueOf(m.id, kpis[m.id as MetricId]))

      const started = await getTrialStats(database.db, ids, range, "UTC")
      expect(answer.data.started_in_range).toMatchObject({ started: { count: started.started }, converted: { count: started.converted }, canceled: { count: started.canceled }, still_running: { count: started.open } })

      const open = answer.data.open_trials
      expect(kpis.trialSubs).toBeGreaterThan(3)
      expect(open.total.count).toBe(kpis.trialSubs)
      expect(open.mrr_if_all_convert.cents).toBe(kpis.trialMrr)
      expect(open.ending_soonest).toHaveLength(3)
      const ends = open.ending_soonest.map((t: Answer) => t.ends_at)
      expect(ends).toEqual([...ends].sort())
      for (const t of open.ending_soonest) {
        const shop = (await listShops(database.db, [t.app_id], { shop: t.shop })).rows[0]
        expect(shop, t.shop).toMatchObject({ inTrial: true, monthlyCents: t.monthly_price.cents })
      }
    })
  })

  describe("get_retention", () => {
    it("returns the retention page: rates, the starting group and both cohort tables, equal to the dashboard's", async () => {
      const range = { from: addDays(today, -119), to: today }
      const answer = await call("get_retention", range)
      const { kpis } = await dashboard(ids, range)
      for (const m of answer.data.metrics) expect(m.value, m.id).toEqual(valueOf(m.id, kpis[m.id as MetricId]))

      const start = addRetention([...(await getRetention(database.db, ids, range, "UTC")).values()])
      expect(answer.data.starting_group).toMatchObject({ installs_at_start: { count: start.startInstalls }, subscribers_kept: { count: start.keptSubs }, mrr_at_start: { cents: start.startMrr }, mrr_kept: { cents: start.keptMrr } })

      const passed = <T>(cells: (T | null)[]) => cells.filter((c): c is T => c !== null)
      const installs = cohortRetention(await getStays(database.db, ids, range, "UTC"), "week", new Date(), "UTC", 12)
      expect(answer.data.install_cohorts.by).toBe("week")
      expect(answer.data.install_cohorts.cohorts.map((c: Answer) => [c.cohort, c.installs.count, c.still_installed.map((s: Answer) => s.ratio)])).toEqual(
        installs.map((c) => [c.cohort, c.size, passed(c.cells).map((s) => percent(s)!.ratio)])
      )

      const revenue = await getRevenueCohorts(database.db, ids, range, "UTC", new Date())
      expect(revenue.length).toBeGreaterThanOrEqual(3)
      expect(answer.data.revenue_cohorts.cohorts.map((c: Answer) => [c.cohort, c.shops.count, c.mrr_at_start.cents, c.months.map((m: Answer) => m.mrr.cents)])).toEqual(
        revenue.map((c) => [c.cohort, c.shops, c.startMrr, passed(c.cells).map((m) => m.mrr)])
      )
    })

    it("follows install cohorts by month for a long range, as the dashboard does, or by what is asked, keeping the latest 52", async () => {
      expect((await call("get_retention", { preset: "last_12_months" })).data.install_cohorts.by).toBe("month")
      const weekly = await call("get_retention", { preset: "last_12_months", cohort_by: "week" })
      expect(weekly.data.install_cohorts.by).toBe("week")
      expect(weekly.data.install_cohorts.cohorts).toHaveLength(52)
      expect(weekly.notes.some((n: string) => n.startsWith("There are") && n.includes("the latest 52 are shown"))).toBe(true)
    })
  })

  describe("list_shops", () => {
    it("lists the shops as the shops page does, page by page", async () => {
      const first = await call("list_shops", { page_size: 5 })
      const expected = await listShops(database.db, ids, { page: 1, pageSize: 5 })
      expect(first.data.total.count).toBe(expected.total)
      expect(first.data.rows.map((r: Answer) => [r.app_id, r.shop])).toEqual(expected.rows.map((r) => [r.appId, r.shop]))
      expect(first.data).toMatchObject({ page: 1, page_size: 5, pages: Math.ceil(expected.total / 5), next_page: 2 })

      const second = await call("list_shops", { page_size: 5, page: 2 })
      expect(second.data.rows.map((r: Answer) => r.shop)).toEqual((await listShops(database.db, ids, { page: 2, pageSize: 5 })).rows.map((r) => r.shop))

      const past = await call("list_shops", { page_size: 5, page: 10_000 })
      expect(past.data).toMatchObject({ rows: [], total: { count: expected.total }, next_page: null })
      expect(past.notes).toContain(`Page 10000 is past the last page, ${Math.ceil(expected.total / 5)}.`)
      expect(await refusal("list_shops", { page_size: 101 })).toContain("Input validation error")
    })

    it("filters, sorts and searches as the shops page does, and finds one shop by its domain", async () => {
      const paying = await call("list_shops", { plan: "paying", sort: "mrr", page_size: 100 })
      const expected = await listShops(database.db, ids, { plan: "paying", sort: "mrr", pageSize: 100 })
      expect(paying.data.rows.map((r: Answer) => [r.shop, r.mrr.cents])).toEqual(expected.rows.map((r) => [r.shop, r.monthlyCents]))
      for (const r of paying.data.rows) expect(r.plan).toMatchObject({ status: "paying", monthly_price: r.mrr })

      const search = await call("list_shops", { search: "shop-12", status: "installed", page_size: 100 })
      expect(search.data.rows.map((r: Answer) => r.shop)).toEqual((await listShops(database.db, ids, { q: "shop-12", status: "installed", pageSize: 100 })).rows.map((r) => r.shop))

      const domain = expected.rows[0].shop
      const one = await call("list_shops", { shop: domain.toUpperCase() })
      expect(one.data.rows.map((r: Answer) => r.shop)).toEqual([domain])
      expect((await call("list_shops", { shop: "nobody.myshopify.com" })).data).toMatchObject({ rows: [], total: { count: 0 } })
    })

    it("gives and takes aliases for a token that hides domains, and will not search or sort by domain", async () => {
      const answer = await call("list_shops", { plan: "paying", sort: "mrr", page_size: 3 }, hidden)
      const expected = await listShops(database.db, ids, { plan: "paying", sort: "mrr", pageSize: 3 })
      expect(answer.data.rows.map((r: Answer) => r.shop)).toEqual(expected.rows.map((r) => alias(r.shop)))
      expect(JSON.stringify(answer)).not.toContain("myshopify.com")

      const one = await call("list_shops", { shop: alias(expected.rows[0].shop) }, hidden)
      expect(one.data.rows.map((r: Answer) => r.shop)).toEqual([alias(expected.rows[0].shop)])
      expect(await refusal("list_shops", { shop: expected.rows[0].shop }, hidden)).toContain("Give the shop's alias")
      expect(await refusal("list_shops", { search: "demo" }, hidden)).toContain("cannot search them")
      expect(await refusal("list_shops", { sort: "shop" }, hidden)).toContain("cannot sort by them")
    })
  })

  describe("get_shop_timeline", () => {
    async function payingShop() {
      const [s] = (await listShops(database.db, ids, { plan: "paying", sort: "revenue", pageSize: 1 })).rows
      return s
    }

    it("returns one shop's history in one app, as the shop page shows it", async () => {
      const s = await payingShop()
      const answer = await call("get_shop_timeline", { app_id: s.appId, shop: s.shop })
      const t = (await getShopTimeline(database.db, s.appId, s.shop, { maxEvents: 50 }))!
      const totals = await getShopTotals(database.db, s.appId, s.shop)
      expect(answer.data).toMatchObject({ app: { id: s.appId }, shop: s.shop, excluded: false, standing: { installed: true, plan: { status: "paying" }, mrr: { cents: s.monthlyCents } } })
      expect(answer.data.totals).toEqual({ charged: { cents: totals.chargedCents, formatted: expect.any(String) }, refunded: expect.objectContaining({ cents: totals.refundedCents }), net_earned: expect.objectContaining({ cents: totals.netEarnedCents }) })
      expect(answer.data.totals.charged.cents).toBe(s.charged)
      expect(answer.data.stays).toHaveLength(t.stays.length)
      expect(answer.data.subscriptions.map((p: Answer) => p.monthly_price.cents)).toEqual(t.subscriptions.map((p) => p.monthlyCents))
      expect(answer.data.trials.map((x: Answer) => x.outcome)).toEqual(t.trials.map((x) => x.outcome))
      expect(answer.data.events.map((e: Answer) => e.id)).toEqual(t.events.map((e) => e.id))
      expect(answer.data.event_count.count).toBe(t.eventCount)
    })

    it("keeps the latest events when it caps them, and says how many there are", async () => {
      const s = await payingShop()
      const answer = await call("get_shop_timeline", { app_id: s.appId, shop: s.shop, max_events: 2 })
      const t = (await getShopTimeline(database.db, s.appId, s.shop, { maxEvents: 2 }))!
      expect(answer.data.events.map((e: Answer) => e.id)).toEqual(t.events.map((e) => e.id))
      expect(answer.notes).toContain(`The shop has ${t.eventCount} events; the latest 2 are listed. Ask for up to 200 with max_events.`)
    })

    it("takes the shop's alias, and only its alias, for a token that hides domains", async () => {
      const s = await payingShop()
      const answer = await call("get_shop_timeline", { app_id: s.appId, shop: alias(s.shop) }, hidden)
      expect(answer.data.shop).toBe(alias(s.shop))
      expect(JSON.stringify(answer)).not.toContain("myshopify.com")
      expect(await refusal("get_shop_timeline", { app_id: s.appId, shop: s.shop }, hidden)).toContain("Give the shop's alias")
      expect(await refusal("get_shop_timeline", { app_id: s.appId, shop: "shop_0000000000" }, hidden)).toBe("No shop of this app matches shop_0000000000. list_shops gives the shops.")
      expect(await refusal("get_shop_timeline", {})).toContain("Input validation error")
    })
  })

  describe("get_data_health", () => {
    it("covers the visible apps and says how many are hidden", async () => {
      await database.db.update(apps).set({ hidden: true }).where(eq(apps.id, ids[2]))
      try {
        const answer = await call("get_data_health")
        const expected = await getDataHealth(database.db, [ids[0], ids[1]], "UTC", new Date())
        expect(answer.data.hidden_apps.count).toBe(1)
        expect(answer.notes).toContain("1 app is hidden in Settings and left out, as on the dashboard.")
        expect(answer.data.apps.map((a: Answer) => [a.id, a.events.count, a.event_types.length])).toEqual(expected.apps.map((a) => [a.appId, a.eventCount, a.eventTypes.length]))
        expect(answer.data.months).toEqual(expected.months)
        expect(answer.data.connections.map((c: Answer) => c.label)).toEqual(["Demo organization"])
        expect(JSON.stringify(answer)).not.toContain(ids[2])
      } finally {
        await database.db.update(apps).set({ hidden: false }).where(eq(apps.id, ids[2]))
      }
    })
  })

  describe("get_at_risk", () => {
    // Demo data has no cancel that takes effect later, so the two highest paying shops get one, 10
    // and 20 days ahead, for these tests only.
    const added: ParsedEvent[] = []

    beforeAll(async () => {
      const [c] = await database.db.select({ id: connections.id }).from(connections)
      const gidOf = new Map((await listApps(database.db)).map((a) => [a.id, a.gid]))
      const paying = (await listShops(database.db, ids, { plan: "paying", sort: "mrr", pageSize: 2 })).rows
      const now = Date.now()
      paying.forEach((s, i) => {
        const day = new Date(now + (i + 1) * 10 * DAY).toISOString().slice(0, 10)
        added.push({
          id: `at-risk-test-${i}`, occurredAt: new Date(now - 60_000), type: "SUBSCRIPTION_CANCELLATION_SCHEDULED", appGid: gidOf.get(s.appId) as string, appName: null, appApiKey: null,
          shop: s.shop, shopGid: null, state: null, reason: null, reasonDescription: null, planHandle: null, billingPeriod: null, trialDays: null, trialDaysRemaining: null,
          cancelEffectiveOn: new Date(`${day}T00:00:00Z`), amountCents: null, currency: null, grossCents: null, netCents: null, feeCents: null, chargeId: null, payload: {},
        })
      })
      await insertEvents(database.db, c.id, added)
      await rebuildStaleApps(database.db, new Date())
    })

    afterAll(async () => {
      await database.db.delete(events).where(inArray(events.id, added.map((e) => e.id)))
      for (const id of ids) await rebuildApp(database.db, id, "UTC", new Date())
    })

    it("returns the at-risk card's three lists, equal to the dashboard's read at the same moment", async () => {
      const answer = await call("get_at_risk", { limit: 1 })
      const risk = await getAtRisk(database.db, ids, new Date(answer.data.as_of), 1)
      expect(answer.range).toBeUndefined()
      expect(answer.data.apps.map((a: Answer) => a.id).sort()).toEqual([...ids].sort())

      const set = answer.data.set_to_end
      expect(set.subscriptions.count).toBe(2)
      expect(set.metric).toMatchObject({ id: "mrrSetToEnd", value: { cents: risk.setToEnd.mrrCents }, definition: AT_RISK_METRICS.mrrSetToEnd.description })
      expect(set.ending_soonest.map((r: Answer) => [r.app_id, r.shop, r.monthly_price.cents, r.cancel_effective_on])).toEqual(
        risk.setToEnd.rows.map((r) => [r.appId, r.shop, r.monthlyCents, r.endsAt.toISOString().slice(0, 10)])
      )
      expect(set.ending_soonest[0].cancel_effective_on).toBe(added[0].cancelEffectiveOn!.toISOString().slice(0, 10))

      const trials = answer.data.trials_ending_soon
      expect(risk.trialsEnding.count).toBeGreaterThan(0)
      expect(trials.metric.value.count).toBe(risk.trialsEnding.count)
      expect(trials.mrr_if_all_convert.cents).toBe(risk.trialsEnding.mrrCents)
      expect(trials.ending_soonest.map((r: Answer) => [r.shop, r.ends_at])).toEqual(risk.trialsEnding.rows.map((r) => [r.shop, r.endsAt.toISOString()]))

      expect(answer.data.frozen.metric.value.cents).toBe(risk.frozen.mrrCents)
      expect(answer.data.frozen.subscriptions.count).toBe(risk.frozen.count)
      expect(answer.data.frozen.latest.map((r: Answer) => [r.shop, r.frozen_at])).toEqual(risk.frozen.rows.map((r) => [r.shop, r.frozenAt.toISOString()]))
      expect(answer.notes).toContain("Each list holds at most 1 shop, and its count covers them all. Ask for up to 100 with limit.")
    })

    it("gives aliases to a token that hides shop domains, and reads one app when asked", async () => {
      const answer = await call("get_at_risk", { limit: 100 }, hidden)
      const risk = await getAtRisk(database.db, ids, new Date(answer.data.as_of), 100)
      expect(answer.data.set_to_end.ending_soonest.map((r: Answer) => r.shop)).toEqual(risk.setToEnd.rows.map((r) => alias(r.shop)))
      expect(answer.data.trials_ending_soon.ending_soonest.map((r: Answer) => r.shop)).toEqual(risk.trialsEnding.rows.map((r) => alias(r.shop)))
      expect(JSON.stringify(answer)).not.toContain("myshopify.com")

      const appId = risk.setToEnd.rows[0].appId
      const one = await call("get_at_risk", { app_ids: [appId] })
      expect(one.data.set_to_end.subscriptions.count).toBe((await getAtRisk(database.db, [appId], new Date(one.data.as_of))).setToEnd.count)
      expect(await refusal("get_at_risk", { limit: 101 })).toContain("Input validation error")
    })
  })

  it("never shows a shop domain to a token that hides them, in any field of any tool, errors and notes included", async () => {
    // Every demo shop is demo-shop-<n>.myshopify.com, so two patterns find any of them in any text.
    const domains = (await database.db.selectDistinct({ shop: events.shop }).from(events)).flatMap((r) => (r.shop ? [r.shop] : []))
    expect(domains.length).toBeGreaterThan(100)
    for (const domain of domains) expect(domain).toMatch(/^demo-shop-\d+\.myshopify\.com$/)

    // Besides a shop field, a domain can come in a merchant's comment, in an error Shopify sent on a
    // sync, or with an excluded shop. The latest uninstall gets a comment naming two shops.
    const [c] = await database.db.select({ id: connections.id }).from(connections)
    const [uninstall] = await database.db
      .select({ id: events.id, appId: events.appId, shop: events.shop, text: events.reasonDescription })
      .from(events)
      .where(and(inArray(events.appId, ids), eq(events.type, "RELATIONSHIP_UNINSTALLED"), isNotNull(events.shop)))
      .orderBy(desc(events.occurredAt))
      .limit(1)
    const left = uninstall.shop as string
    const [paying, named, excluded] = (await listShops(database.db, ids, { plan: "paying", sort: "mrr", pageSize: 3 })).rows
    const failure = `Partner API error: Shop ${paying.shop} could not be read.`
    const comment = `Moving to ${named.shop}. Write to ${left.toUpperCase()}.`

    let run: string | undefined
    try {
      await database.db.update(events).set({ reasonDescription: comment }).where(eq(events.id, uninstall.id))
      await database.db.update(connections).set({ lastError: failure, earningsError: failure, legacyError: failure }).where(eq(connections.id, c.id))
      run = (await database.db.insert(syncRuns).values({ connectionId: c.id, trigger: "schedule", finishedAt: new Date(), ok: false, error: failure }).returning({ id: syncRuns.id }))[0].id
      await addExcludedShop(database.db, excluded.shop, null)
      await rebuildStaleApps(database.db, new Date())

      const asks: Record<string, Record<string, unknown>[]> = {
        list_apps: [{}],
        get_definitions: [{}, { id: "mrr" }],
        get_metrics: [{ preset: "all_time", compare: "previous_period", metrics: RANGE_METRIC_IDS }],
        get_timeseries: [{ preset: "last_90_days", granularity: "week", per_app: true }],
        explain_mrr_change: [{ preset: "all_time", limit: 50 }],
        get_churn: [{ preset: "all_time", compare: "previous_period", comments_limit: 100, returns_limit: 50 }],
        get_trials: [{ preset: "all_time", compare: "previous_year", limit: 100 }],
        get_retention: [{ preset: "all_time", cohort_by: "month" }],
        list_shops: [
          { page_size: 100 },
          { plan: "paying", sort: "mrr", page_size: 100 },
          { status: "uninstalled", sort: "revenue", page_size: 100 },
          { shop: alias(left) },
          { shop: "shop_0000000000" },
          { shop: paying.shop },
          { search: "demo" },
          { sort: "shop" },
        ],
        get_shop_timeline: [
          { app_id: uninstall.appId, shop: alias(left), max_events: 200 },
          { app_id: excluded.appId, shop: alias(excluded.shop), max_events: 200 },
          { app_id: paying.appId, shop: "shop_0000000000" },
          { app_id: paying.appId, shop: paying.shop },
        ],
        get_data_health: [{}],
        get_at_risk: [{ limit: 100 }],
      }
      // A tool added later has to be added here too.
      expect(Object.keys(asks).sort()).toEqual(TOOLS.map((t) => t.name).sort())

      const answers = new Map<string, Answer[]>()
      for (const [name, list] of Object.entries(asks)) {
        for (const args of list) {
          const { isError, text, answer, raw } = await send(name, args, hidden)
          expect(raw, `${name} ${JSON.stringify(args)}`).not.toMatch(/myshopify\.com|demo-shop-\d/i)
          answers.set(name, [...(answers.get(name) ?? []), isError ? text : answer])
        }
      }

      // Each way in was taken, and came out as aliases.
      expect(answers.get("list_shops")![1].data.rows.map((r: Answer) => r.shop)).toEqual(expect.arrayContaining([alias(paying.shop), alias(named.shop)]))
      const [churn] = answers.get("get_churn")!
      expect(churn.data.comments.list.map((m: Answer) => m.merchant_text_untrusted)).toContain(`Moving to ${alias(named.shop)}. Write to ${alias(left)}.`)
      const aliased = `Partner API error: Shop ${alias(paying.shop)} could not be read.`
      const [health] = answers.get("get_data_health")!
      expect(health.data.connections[0]).toMatchObject({ last_error: aliased, earnings_error: aliased, billing_events_error: aliased })
      expect(health.data.connections[0].runs[0].error).toBe(aliased)
      expect(answers.get("list_apps")![0].data.connections[0].last_error).toBe(aliased)
      const [stay, out, unknown, domain] = answers.get("get_shop_timeline")!
      expect(stay.data.stays.at(-1).merchant_text_untrusted).toBe(`Moving to ${alias(named.shop)}. Write to ${alias(left)}.`)
      expect(out.data).toMatchObject({ shop: alias(excluded.shop), excluded: true, standing: null })
      expect([unknown, domain]).toEqual(["No shop of this app matches shop_0000000000. list_shops gives the shops.", expect.stringContaining("Give the shop's alias")])
    } finally {
      await database.db.update(events).set({ reasonDescription: uninstall.text }).where(eq(events.id, uninstall.id))
      await database.db.update(connections).set({ lastError: null, earningsError: null, legacyError: null }).where(eq(connections.id, c.id))
      if (run) await database.db.delete(syncRuns).where(eq(syncRuns.id, run))
      await removeExcludedShop(database.db, excluded.shop)
      await rebuildStaleApps(database.db, new Date())
    }
  })
})
