import { randomBytes } from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { POST } from "@/app/api/mcp/route"
import { AT_RISK_METRICS, COHORT_METRICS, METRICS } from "@/lib/analytics/metrics-registry"
import { rebuildStaleApps } from "@/lib/analytics/rebuild"
import { createApiToken, revokeApiToken, type NewApiToken } from "@/lib/auth/api-tokens"
import { getDatabase, type Database } from "@/lib/db/client"
import { apiCalls, apiTokens, apps, connections, loginAttempts } from "@/lib/db/schema"
import { generateDemoEvents } from "@/lib/demo/generate"
import { resetEnvCache } from "@/lib/env"
import { createContext, readOnly } from "@/lib/mcp/context"
import { shopAlias } from "@/lib/mcp/output"
import { ToolError } from "@/lib/mcp/tool"
import { insertEvents } from "@/lib/partner/store"
import { clearAll, hasDatabase, openTestDatabase, TEST_DATABASE_URL } from "../helpers/db"

// The endpoint as an agent meets it: Requests to the route handler, answered by the real stack
// (token check, rate limit, SDK, tools, read-only transactions, call log) on a real Postgres.

const SECRET = "mcp-test-session-secret-0123456789-abcdefghij"
const DAY = 86_400_000
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }
const plain: NewApiToken = { name: "Claude Code", expiresInDays: null, hideShops: false }
const TOOL_NAMES = ["explain_mrr_change", "get_churn", "get_data_health", "get_definitions", "get_metrics", "get_retention", "get_shop_timeline", "get_timeseries", "get_trials", "list_apps", "list_shops"]

type Options = { token?: string; legacy?: boolean; headers?: Record<string, string>; url?: string }

/** A JSON-RPC request as a client on the 2026-07-28 revision sends it, or as a 2025-era client does (legacy). */
function rpc(method: string, params: Record<string, unknown> | undefined, options: Options = {}): Request {
  const legacy = options.legacy ?? false
  const body = { jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: 1 }), method, ...(params || !legacy ? { params: { ...params, ...(legacy ? {} : { _meta: META }) } } : {}) }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  if (!legacy) {
    headers["mcp-protocol-version"] = "2026-07-28"
    headers["mcp-method"] = method
    const name = method === "tools/call" ? params?.name : method === "resources/read" ? params?.uri : undefined
    if (typeof name === "string") headers["mcp-name"] = name
  }
  return new Request(options.url ?? "http://localhost/api/mcp", { method: "POST", headers: { ...headers, ...options.headers }, body: JSON.stringify(body) })
}

/** The response, with its JSON-RPC message read from JSON or from a server-sent event. */
async function send(request: Request) {
  const response = await POST(request)
  const text = await response.text()
  const type = response.headers.get("content-type") ?? ""
  const data = type.includes("text/event-stream") ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) : text
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message: any = data ? JSON.parse(data) : null
  return { status: response.status, headers: response.headers, type, message }
}

describe.skipIf(!hasDatabase)("MCP endpoint (Postgres)", () => {
  let database: Database

  beforeAll(async () => {
    // The route reads its settings from the environment, as it does in production.
    Object.assign(process.env, {
      DATABASE_URL: TEST_DATABASE_URL,
      DASHBOARD_USER: "owner",
      DASHBOARD_PASSWORD: "a-long-test-password",
      SESSION_SECRET: SECRET,
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    })
    resetEnvCache()
    database = await openTestDatabase()
  })
  beforeEach(() => clearAll(database))
  afterAll(async () => {
    await database.close()
    await getDatabase().close()
  })

  async function token(input: Partial<NewApiToken> = {}, at: Date = new Date()): Promise<{ id: string; token: string }> {
    const created = await createApiToken(database.db, SECRET, { ...plain, ...input }, at)
    if (!created.ok) throw new Error("expected the token to be created")
    return created
  }

  const calls = () => database.db.select({ tool: apiCalls.tool, ok: apiCalls.ok, durationMs: apiCalls.durationMs, tokenId: apiCalls.tokenId }).from(apiCalls).orderBy(apiCalls.id)

  async function seedDemo(): Promise<void> {
    const now = new Date()
    const [c] = await database.db
      .insert(connections)
      .values({ label: "Demo organization", partnerId: "0", tokenCiphertext: "x", tokenHint: "demo", backfillFrom: new Date(now.getTime() - 90 * DAY), isDemo: true, paused: true, lastOkAt: now, lastRunAt: now })
      .returning({ id: connections.id })
    await insertEvents(database.db, c.id, generateDemoEvents({ now, days: 60, seed: 3 }).events)
    await rebuildStaleApps(database.db, now)
  }

  describe("the token", () => {
    it("is required: no token, a bad one, a revoked one and an expired one get 401 with a Bearer challenge", async () => {
      const revoked = await token({ name: "revoked" })
      await revokeApiToken(database.db, revoked.id)
      const expired = await token({ name: "expired", expiresInDays: 30 }, new Date(Date.now() - 31 * DAY))

      const none = await send(rpc("tools/list", undefined))
      expect(none.status).toBe(401)
      expect(none.headers.get("www-authenticate")).toBe('Bearer realm="AppMetrics"')

      for (const bad of ["nope", `amt_${"A".repeat(43)}`, revoked.token, expired.token]) {
        const refused = await send(rpc("tools/list", undefined, { token: bad }))
        expect(refused.status, bad.slice(0, 8)).toBe(401)
        expect(refused.headers.get("www-authenticate")).toMatch(/^Bearer realm="AppMetrics", error="invalid_token"/)
        expect(refused.message.error).toBe("invalid_token")
      }
      expect(await calls()).toEqual([])
    })

    it("is never read from the URL", async () => {
      const { token: value } = await token()
      for (const url of [`http://localhost/api/mcp?token=${value}`, `http://localhost/api/mcp?access_token=${value}`]) {
        expect((await send(rpc("tools/list", undefined, { url }))).status).toBe(401)
      }
    })

    it("records its last use", async () => {
      const { id, token: value } = await token()
      expect((await send(rpc("tools/list", undefined, { token: value }))).status).toBe(200)
      const [row] = await database.db.select({ lastUsedAt: apiTokens.lastUsedAt }).from(apiTokens).where(eq(apiTokens.id, id))
      expect(row.lastUsedAt).not.toBeNull()
    })
  })

  it("refuses a request sent by a web page", async () => {
    const { token: value } = await token()
    const response = await send(rpc("tools/list", undefined, { token: value, headers: { origin: "https://evil.example" } }))
    expect(response.status).toBe(403)
    expect(await calls()).toEqual([])
  })

  describe("the protocol", () => {
    it("lists the tools, read-only, to a client on the 2026-07-28 revision", async () => {
      const { token: value } = await token()
      const { status, type, message } = await send(rpc("tools/list", undefined, { token: value }))
      expect(status).toBe(200)
      expect(type).toContain("application/json")
      const tools = message.result.tools
      expect(tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES)
      for (const tool of tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
        expect(tool.description.length).toBeGreaterThan(50)
        expect(tool.inputSchema.type).toBe("object")
      }
    })

    it("serves a 2025-era client without a session: initialize, then tools/list", async () => {
      const { token: value } = await token()
      const init = await send(rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }, { token: value, legacy: true }))
      expect(init.status).toBe(200)
      expect(init.message.result.protocolVersion).toBe("2025-11-25")
      expect(init.message.result.serverInfo.name).toBe("appmetrics")
      expect(init.message.result.capabilities.tools).toEqual({ listChanged: false })
      expect(init.message.result.instructions).toContain("list_apps")
      expect(init.headers.get("mcp-session-id")).toBeNull()

      expect((await send(rpc("notifications/initialized", undefined, { token: value, legacy: true }))).status).toBe(202)
      const list = await send(rpc("tools/list", undefined, { token: value, legacy: true }))
      expect(list.status).toBe(200)
      expect(list.type).toContain("text/event-stream")
      expect(list.message.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOL_NAMES)
    })

    it("answers server/discover with the 2026-07-28 revision", async () => {
      const { token: value } = await token()
      const { status, message } = await send(rpc("server/discover", undefined, { token: value }))
      expect(status).toBe(200)
      expect(message.result.supportedVersions).toEqual(["2026-07-28"])
      expect(message.result.capabilities).toMatchObject({ tools: { listChanged: false }, resources: { listChanged: false } })
    })
  })

  describe("list_apps", () => {
    it("returns the demo apps, leaving out a hidden one, in the standard envelope", async () => {
      await seedDemo()
      const all = await database.db.select({ id: apps.id, name: apps.name }).from(apps).orderBy(apps.name)
      expect(all).toHaveLength(3)
      await database.db.update(apps).set({ hidden: true }).where(eq(apps.id, all[1].id))
      const { token: value } = await token()

      const { status, message } = await send(rpc("tools/call", { name: "list_apps", arguments: {} }, { token: value }))
      expect(status).toBe(200)
      const result = message.result
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)

      const answer = result.structuredContent
      expect(Object.keys(answer)).toEqual(["timezone", "notes", "data"])
      expect(answer.timezone).toBe("UTC")
      expect(answer.data.apps.map((a: { name: string }) => a.name)).toEqual([all[0].name, all[2].name])
      expect(JSON.stringify(answer)).not.toContain(all[1].id)
      for (const a of answer.data.apps) {
        expect(a.connection).toBe("Demo organization")
        expect(a.first_event_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
        expect(a.last_built_at).not.toBeNull()
      }
      expect(answer.data.connections).toHaveLength(1)
      expect(answer.data.connections[0]).toMatchObject({ label: "Demo organization", demo: true, earnings_readable: true, last_error: null })
      expect(answer.notes).toContain("Demo organization holds demo data made up by the seed-demo command. None of it is real.")
    })

    it("says so when nothing is connected", async () => {
      const { token: value } = await token()
      const { message } = await send(rpc("tools/call", { name: "list_apps", arguments: {} }, { token: value, legacy: true }))
      expect(message.result.structuredContent.data).toEqual({ apps: [], connections: [] })
      expect(message.result.structuredContent.notes).toEqual(["Nothing is connected yet. A Shopify Partner API token is added in Settings."])
    })
  })

  describe("the definitions", () => {
    it("come as a tool, for every metric or for one", async () => {
      const { token: value } = await token()
      const all = (await send(rpc("tools/call", { name: "get_definitions", arguments: {} }, { token: value }))).message.result.structuredContent
      expect(all.data.metrics).toHaveLength(Object.keys(METRICS).length + Object.keys(COHORT_METRICS).length + Object.keys(AT_RISK_METRICS).length)
      expect(all.data.conventions.length).toBeGreaterThan(10)
      expect(all.data.answer_format.join(" ")).toContain("merchant_text_untrusted")

      const one = (await send(rpc("tools/call", { name: "get_definitions", arguments: { id: "subChurnRate" } }, { token: value }))).message.result.structuredContent
      expect(one.data).toEqual({ metric: expect.objectContaining({ id: "subChurnRate", label: "Subscriber churn", unit: "percent", better_when: "lower" }) })

      const unknown = (await send(rpc("tools/call", { name: "get_definitions", arguments: { id: "nope" } }, { token: value }))).message.result
      expect(unknown.isError).toBe(true)
      expect(unknown.content[0].text).toContain("id")
    })

    it("come as a markdown resource", async () => {
      const { token: value } = await token()
      const { status, message } = await send(rpc("resources/read", { uri: "appmetrics://definitions" }, { token: value }))
      expect(status).toBe(200)
      const [content] = message.result.contents
      expect(content.mimeType).toBe("text/markdown")
      expect(content.text).toContain("# Metric definitions")
      expect(content.text).toContain(`| mrr | MRR | ${METRICS.mrr.description} |`)
    })
  })

  describe("reads", () => {
    it("run in a read-only transaction with a 15 second statement timeout", async () => {
      const settings = await readOnly(database.db, async (tx) => {
        const [{ transaction_read_only }] = await tx.execute<{ transaction_read_only: string }>(sql`show transaction_read_only`)
        const [{ statement_timeout }] = await tx.execute<{ statement_timeout: string }>(sql`show statement_timeout`)
        return { transaction_read_only, statement_timeout }
      })
      expect(settings).toEqual({ transaction_read_only: "on", statement_timeout: "15s" })
      // The timeout ends with the transaction; the pool's own setting is untouched.
      const [{ statement_timeout }] = await database.db.execute<{ statement_timeout: string }>(sql`show statement_timeout`)
      expect(statement_timeout).toBe("0")
    })

    it("cannot write: an insert inside read() fails and leaves nothing behind", async () => {
      const ctx = createContext({ db: database.db, secret: SECRET, token: { id: "t", name: "t", hideShops: false } })
      await expect(ctx.read((q) => q.insert(loginAttempts).values({ key: "x", ok: true }))).rejects.toThrow()
      await expect(readOnly(database.db, (q) => q.execute(sql`delete from api_tokens`))).rejects.toThrow()
      const failure = await readOnly(database.db, (q) => q.insert(loginAttempts).values({ key: "x", ok: true })).catch((error: Error) => error)
      expect(String((failure as Error).cause)).toContain("read-only transaction")
      expect(await database.db.select().from(loginAttempts)).toEqual([])
    })
  })

  describe("the call log", () => {
    it("gets a row for every request: the tool or the method, whether it was ok, and how long it took", async () => {
      const other = await token({ name: "other" })
      const { id, token: value } = await token()

      const requests = [
        rpc("tools/list", undefined, { token: value }),
        rpc("tools/call", { name: "list_apps", arguments: {} }, { token: value }),
        rpc("tools/call", { name: "get_definitions", arguments: { id: "nope" } }, { token: value }),
        rpc("tools/call", { name: "no_such_tool", arguments: {} }, { token: value }),
        rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }, { token: value, legacy: true }),
        rpc("notifications/initialized", undefined, { token: value, legacy: true }),
        rpc("resources/read", { uri: "appmetrics://definitions" }, { token: value }),
        new Request("http://localhost/api/mcp", { method: "POST", headers: { authorization: `Bearer ${value}`, "content-type": "application/json" }, body: "{not json" }),
        rpc("tools/list", undefined, { token: "wrong" }),
      ]
      for (const request of requests) await send(request)
      await send(rpc("tools/list", undefined, { token: other.token }))

      const rows = await calls()
      expect(rows.filter((r) => r.tokenId === id).map(({ tool, ok }) => ({ tool, ok }))).toEqual([
        { tool: "tools/list", ok: true },
        { tool: "list_apps", ok: true },
        { tool: "get_definitions", ok: false },
        { tool: "no_such_tool", ok: false },
        { tool: "initialize", ok: true },
        { tool: "notifications/initialized", ok: true },
        { tool: "resources/read", ok: true },
        { tool: "invalid", ok: false },
      ])
      expect(rows.filter((r) => r.tokenId === other.id).map((r) => r.tool)).toEqual(["tools/list"])
      for (const row of rows) expect(row.durationMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe("the rate limit", () => {
    it("answers 429 with Retry-After past 120 requests a minute, per token", async () => {
      const { id, token: value } = await token()
      for (let i = 0; i < 120; i++) expect((await send(rpc("tools/list", undefined, { token: value }))).status).toBe(200)

      const refused = await send(rpc("tools/list", undefined, { token: value }))
      expect(refused.status).toBe(429)
      const wait = Number(refused.headers.get("retry-after"))
      expect(wait).toBeGreaterThanOrEqual(1)
      expect(wait).toBeLessThanOrEqual(60)
      expect(refused.message.error).toBe("rate_limited")

      const other = await token({ name: "other" })
      expect((await send(rpc("tools/list", undefined, { token: other.token }))).status).toBe(200)
      // Refused requests are not logged, so a runaway agent cannot fill the table.
      expect((await calls()).filter((r) => r.tokenId === id)).toHaveLength(120)
    })
  })

  describe("shops given as input", () => {
    async function seedShops(): Promise<{ appA: string; appB: string }> {
      await seedDemo()
      const [a, b] = await database.db.select({ id: apps.id }).from(apps).orderBy(apps.name)
      return { appA: a.id, appB: b.id }
    }

    it("resolve from a domain, for a token that shows domains", async () => {
      const { appA, appB } = await seedShops()
      const [{ shop }] = await database.db.execute<{ shop: string }>(sql`select shop from events where app_id = ${appA} and shop is not null limit 1`)
      const ctx = createContext({ db: database.db, secret: SECRET, token: { id: "t", name: "t", hideShops: false } })
      expect(await ctx.resolveShop(` ${shop.toUpperCase()} `, [appA])).toBe(shop)
      expect(await ctx.resolveShop("nobody.myshopify.com", [appA])).toBeNull()
      const [{ n }] = await database.db.execute<{ n: number }>(sql`select count(*)::int as n from events where app_id = ${appB} and shop = ${shop}`)
      if (n === 0) expect(await ctx.resolveShop(shop, [appB])).toBeNull()
    })

    it("resolve only from an alias, for a token that hides domains", async () => {
      const { appA } = await seedShops()
      const [{ shop }] = await database.db.execute<{ shop: string }>(sql`select shop from events where app_id = ${appA} and shop is not null limit 1`)
      const ctx = createContext({ db: database.db, secret: SECRET, token: { id: "t", name: "t", hideShops: true } })
      expect(await ctx.resolveShop(shopAlias(SECRET, shop), [appA])).toBe(shop)
      expect(await ctx.resolveShop("shop_0000000000", [appA])).toBeNull()
      await expect(ctx.resolveShop(shop, [appA])).rejects.toBeInstanceOf(ToolError)
    })
  })
})
