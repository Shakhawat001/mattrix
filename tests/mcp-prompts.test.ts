import { describe, expect, it } from "vitest"
import type { Db } from "@/lib/db/client"
import { createContext } from "@/lib/mcp/context"
import { PROMPTS, readRange, renderPlan, type PromptArgs } from "@/lib/mcp/prompts"
import { mcpHandler, TOOLS, toAuthInfo } from "@/lib/mcp/server"
import { strictInput } from "@/lib/mcp/tool"

// The prompts through the SDK's real handler, as Claude Code and Claude Desktop ask for them, and
// every step they ask for checked against the tools' own input schemas.

const SECRET = "a-session-secret-that-is-long-enough-123456"
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }

/** A request from a client on the 2026-07-28 revision, or a 2025-era one (legacy), answered by the SDK's handler. */
async function send(method: string, params: Record<string, unknown> = {}, legacy = false) {
  const ctx = createContext({ db: {} as Db, secret: SECRET, token: { id: "token-1", name: "Test", hideShops: false } })
  const body = { jsonrpc: "2.0", id: 1, method, params: legacy ? params : { ...params, _meta: META } }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" }
  if (!legacy) {
    headers["mcp-protocol-version"] = "2026-07-28"
    headers["mcp-method"] = method
    if (typeof params.name === "string") headers["mcp-name"] = params.name
  }
  const response = await mcpHandler().fetch(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }), { authInfo: toAuthInfo(ctx), parsedBody: body })
  const text = await response.text()
  const data = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").find((line) => line.startsWith("data:"))?.slice(5) : text
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, message: JSON.parse(data ?? "null") as any }
}

async function get(name: string, args?: Record<string, string>) {
  const { status, message } = await send("prompts/get", args ? { name, arguments: args } : { name })
  expect(status).toBe(200)
  expect(message.result.messages).toHaveLength(1)
  expect(message.result.messages[0].role).toBe("user")
  expect(message.result.messages[0].content.type).toBe("text")
  return message.result.messages[0].content.text as string
}

const planOf = (name: string, args: PromptArgs = {}) => PROMPTS.find((p) => p.name === name)!.plan(args)

/** The argument cases every check runs over: no arguments, each kind of range, an app. */
const CASES: [string, PromptArgs][] = [
  ["weekly_review", {}],
  ["investigate_churn", {}],
  ["investigate_churn", { app: "Show Discount", range: "last_month" }],
  ["investigate_churn", { range: "2026-08-01..2026-10-31" }],
  ["investigate_churn", { app: "show", range: "October" }],
  ["at_risk_followup", {}],
]

describe("prompts/list", () => {
  it("lists the three prompts, with titles, descriptions and investigate_churn's optional arguments", async () => {
    const { status, message } = await send("prompts/list")
    expect(status).toBe(200)
    const prompts = message.result.prompts
    expect(prompts.map((p: { name: string }) => p.name)).toEqual(["weekly_review", "investigate_churn", "at_risk_followup"])
    for (const prompt of prompts) {
      expect(prompt.title.length).toBeGreaterThan(0)
      expect(prompt.description.length).toBeGreaterThan(50)
    }
    const churn = prompts.find((p: { name: string }) => p.name === "investigate_churn")
    expect(churn.arguments).toEqual([
      { name: "app", description: expect.stringContaining("id"), required: false },
      { name: "range", description: expect.stringContaining("last_90_days"), required: false },
    ])
    expect(prompts.find((p: { name: string }) => p.name === "weekly_review").arguments).toBeUndefined()
  })

  it("is announced as a capability that never changes, to both protocol eras", async () => {
    const discover = await send("server/discover")
    expect(discover.message.result.capabilities.prompts).toEqual({ listChanged: false })

    const init = await send("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }, true)
    expect(init.message.result.capabilities.prompts).toEqual({ listChanged: false })
    const list = await send("prompts/list", {}, true)
    expect(list.status).toBe(200)
    expect(list.message.result.prompts.map((p: { name: string }) => p.name)).toEqual(["weekly_review", "investigate_churn", "at_risk_followup"])
  })
})

describe("prompts/get", () => {
  it("weekly_review asks for the last 7 days against the 7 before, tool by tool", async () => {
    const text = await get("weekly_review")
    expect(text).toBe(renderPlan(planOf("weekly_review")))
    expect(planOf("weekly_review").steps.map((s) => s.tool)).toEqual(["list_apps", "get_metrics", "get_metrics", "explain_mrr_change", "get_churn", "get_at_risk"])
    expect(text).toMatch(/^Write my weekly review of my Shopify apps from AppMetrics: the last 7 days \(UTC, today included\) against the 7 days before\.\n\nCall these AppMetrics tools, in this order:\n1\. list_apps: /)
    expect(text).toContain('\n2. get_metrics with {"preset":"last_7_days","compare":"previous_period","metrics":["mrr",')
    expect(text).toContain('\n5. get_churn with {"preset":"last_7_days","compare":"previous_period"}: ')
    expect(text).toContain("\n6. get_at_risk: ")
    expect(text).toContain("This week: up to five things to do")
    expect(text).toContain("merchant_text_untrusted")
  })

  it("investigate_churn reads one app over the range given", async () => {
    const text = await get("investigate_churn", { app: "Show Discount", range: "last_month" })
    expect(planOf("investigate_churn").steps.map((s) => s.tool)).toEqual(["list_apps", "get_churn", "get_metrics", "explain_mrr_change", "get_shop_timeline", "get_retention", "get_data_health"])
    expect(text).toMatch(/^Investigate churn for the app "Show Discount" over last month, against the same number of days just before\.\n/)
    expect(text).toContain('1. list_apps: find the app "Show Discount" by its id, name or shopify_name')
    expect(text).toContain('\n2. get_churn with {"app_ids":["APP_ID"],"preset":"last_month","compare":"previous_period","comments_limit":50,"returns_limit":20}: ')
    expect(text).toContain('\n7. get_data_health with {"app_ids":["APP_ID"]}: ')
  })

  it("investigate_churn reads every app over the last 90 days by default", async () => {
    const text = await get("investigate_churn")
    expect(text).toMatch(/^Investigate churn for all my apps together over the last 90 days, /)
    expect(text).toContain('get_churn with {"preset":"last_90_days",')
    expect(text).toContain("\n7. get_data_health: ")
    expect(text).not.toContain("app_ids")
    expect(await get("investigate_churn", { app: " ", range: "" })).toBe(text)
  })

  it("investigate_churn takes two days, and a range typed where the app goes", async () => {
    const days = await get("investigate_churn", { range: "2026-08-01..2026-10-31" })
    expect(days).toMatch(/^Investigate churn for all my apps together over 2026-08-01 to 2026-10-31, /)
    expect(days).toContain('get_retention with {"from":"2026-08-01","to":"2026-10-31"}: ')

    // Claude Code fills the arguments in order: /mcp__appmetrics__investigate_churn last_30_days.
    const alone = await get("investigate_churn", { app: "last_30_days" })
    expect(alone).toMatch(/^Investigate churn for all my apps together over the last 30 days, /)
  })

  it("investigate_churn leaves a range it cannot read to the agent, to turn into days or ask about", async () => {
    const text = await get("investigate_churn", { app: '  "show   discount" ', range: "October" })
    expect(text).toMatch(/^Investigate churn for the app "show discount" over "October", against the same number of days just before\. FROM and TO stand for the first and last day of "October", written YYYY-MM-DD in UTC\. If you cannot tell which days I mean, ask me before you call a tool\.\n/)
    expect(text).toContain('"from":"FROM","to":"TO"')
  })

  it("at_risk_followup asks for the at-risk lists, then each shop's history", async () => {
    const text = await get("at_risk_followup")
    expect(planOf("at_risk_followup").steps.map((s) => s.tool)).toEqual(["list_apps", "get_at_risk", "get_shop_timeline"])
    expect(text).toContain('\n2. get_at_risk with {"limit":50}: ')
    expect(text).toContain('\n3. get_shop_timeline with {"app_id":"APP_ID","shop":"SHOP"}: ')
    expect(text).toContain("never guess contact details")
  })

  it("refuses an unknown prompt and an argument too long to be one", async () => {
    const unknown = await send("prompts/get", { name: "nope" })
    expect(unknown.message.error.code).toBe(-32602)
    const long = await send("prompts/get", { name: "investigate_churn", arguments: { app: "x".repeat(201) } })
    expect(long.message.error.code).toBe(-32602)
  })
})

describe("the prompts", () => {
  it("ask only for tools that exist, with input their schemas take", () => {
    for (const [name, args] of CASES) {
      for (const step of planOf(name, args).steps) {
        const tool = TOOLS.find((t) => t.name === step.tool)
        expect(tool, `${name} asks for ${step.tool}`).toBeDefined()
        // FROM and TO stand for days the agent works out; any real days do here.
        const input = JSON.parse(JSON.stringify(step.input ?? {}).replaceAll('"FROM"', '"2026-08-01"').replaceAll('"TO"', '"2026-10-31"'))
        // The schema the SDK checks a call against, which refuses any field the tool does not take.
        expect(strictInput(tool!).safeParse(input).error, `${name}: ${step.tool}`).toBeUndefined()
      }
    }
  })

  it("are written without em dashes", () => {
    for (const prompt of PROMPTS) {
      expect([prompt.title, prompt.description, ...Object.values(prompt.args ?? {})].join(" ")).not.toMatch(/[—–]/)
    }
    for (const [name, args] of CASES) expect(renderPlan(planOf(name, args))).not.toMatch(/[—–]/)
  })
})

describe("readRange", () => {
  it("reads a preset's name however it is typed, and two days in order", () => {
    expect(readRange("last_90_days")?.input).toEqual({ preset: "last_90_days" })
    expect(readRange("Last 90 days")?.input).toEqual({ preset: "last_90_days" })
    expect(readRange("last-month")?.input).toEqual({ preset: "last_month" })
    for (const text of ["2026-08-01..2026-10-31", "2026-08-01 to 2026-10-31", "2026-08-01/2026-10-31", "2026-08-01 2026-10-31"]) {
      expect(readRange(text)?.input, text).toEqual({ from: "2026-08-01", to: "2026-10-31" })
    }
  })

  it("reads nothing else", () => {
    for (const text of ["October", "90d", "2026-10-31..2026-08-01", "2026-02-30..2026-03-01", "2026-08-01", "last_90_days please"]) expect(readRange(text), text).toBeNull()
  })
})
