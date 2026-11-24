import { afterEach, describe, expect, it, vi } from "vitest"
import { AT_RISK_METRICS, COHORT_METRICS, METRICS } from "@/lib/analytics/metrics-registry"
import type { AppInfo, ConnectionOverview } from "@/lib/analytics/queries"
import type { Db } from "@/lib/db/client"
import { log } from "@/lib/log"
import { bearerToken, unauthorized } from "@/lib/mcp/auth"
import { createContext } from "@/lib/mcp/context"
import { CONVENTION_TEXT, METRIC_DEFINITIONS, renderDefinitionsMarkdown } from "@/lib/mcp/definitions"
import { describeCall, exchangeFailed } from "@/lib/mcp/http"
import { envelope } from "@/lib/mcp/output"
import { mcpHandler, toAuthInfo, TOOLS, toolError, toolResult } from "@/lib/mcp/server"
import { ToolError } from "@/lib/mcp/tool"
import { describeApps, earningsReadable } from "@/lib/mcp/tools/list-apps"

afterEach(() => {
  vi.restoreAllMocks()
})

const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }

/** A request through the SDK's real handler and the real tools. It never reaches the database: the tools are listed, or refused before they run. */
async function rpc(method: string, params: Record<string, unknown>) {
  const ctx = createContext({ db: {} as Db, secret: "a-session-secret-that-is-long-enough-123456", token: { id: "token-1", name: "Test", hideShops: false } })
  const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method }
  if (typeof params.name === "string") headers["mcp-name"] = params.name
  const response = await mcpHandler().fetch(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }), { authInfo: toAuthInfo(ctx), parsedBody: body })
  expect(response.status).toBe(200)
  return (await response.json()).result
}

describe("bearerToken", () => {
  it("reads the token from an Authorization: Bearer header, in any case", () => {
    expect(bearerToken("Bearer amt_abc")).toBe("amt_abc")
    expect(bearerToken("bearer amt_abc")).toBe("amt_abc")
    expect(bearerToken("  BEARER   amt_abc  ")).toBe("amt_abc")
  })

  it("finds nothing in another scheme, an empty header or a list of tokens", () => {
    for (const header of [null, "", "Bearer", "Bearer ", "Basic YWJjOmRlZg==", "Token amt_abc", "Bearer amt_a amt_b", "Bearer amt_a, Bearer amt_b", "Beareramt_abc"]) {
      expect(bearerToken(header), String(header)).toBeNull()
    }
  })
})

describe("unauthorized", () => {
  it("asks for a bearer token, with no error code when none was sent", async () => {
    const response = unauthorized("missing")
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="AppMetrics"')
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect((await response.json()).error).toBe("unauthorized")
  })

  it("says invalid_token when the token was refused", async () => {
    const response = unauthorized("invalid")
    expect(response.status).toBe(401)
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="AppMetrics", error="invalid_token", error_description="The token is unknown, revoked or expired."')
    expect((await response.json()).error).toBe("invalid_token")
  })
})

describe("describeCall", () => {
  it("names the tool for a tools/call and the method for anything else", () => {
    expect(describeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_apps", arguments: {} } })).toBe("list_apps")
    expect(describeCall({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBe("tools/list")
    expect(describeCall({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe("notifications/initialized")
    expect(describeCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toBe("tools/call")
  })

  it("keeps what it stores short and plain", () => {
    expect(describeCall({ method: "tools/call", params: { name: "drop table; --" } })).toBe("drop_table__--")
    expect(describeCall({ method: "x".repeat(500) })).toHaveLength(64)
    expect(describeCall([{ method: "tools/list" }])).toBe("batch")
    for (const body of [null, 42, "tools/list", {}, { method: 7 }, { method: "" }]) expect(describeCall(body)).toBe("invalid")
  })
})

describe("exchangeFailed", () => {
  const json = "application/json"
  const sse = "text/event-stream"
  const event = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`

  it("sees a result as a success, in JSON or in server-sent events", () => {
    expect(exchangeFailed(200, json, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }))).toBe(false)
    expect(exchangeFailed(200, sse, event({ jsonrpc: "2.0", id: 1, result: { content: [] } }))).toBe(false)
    expect(exchangeFailed(202, null, "")).toBe(false)
  })

  it("sees an HTTP error, a JSON-RPC error and a tool result marked isError as failures", () => {
    expect(exchangeFailed(401, json, "{}")).toBe(true)
    expect(exchangeFailed(200, json, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Tool nope not found" } }))).toBe(true)
    expect(exchangeFailed(200, json, JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } }))).toBe(true)
    expect(exchangeFailed(200, sse, `: keepalive\n\n${event({ jsonrpc: "2.0", id: 1, result: { content: [], isError: true } })}`)).toBe(true)
    expect(exchangeFailed(200, json, JSON.stringify([{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: 2, error: { code: 1, message: "x" } }]))).toBe(true)
  })
})

describe("tool results", () => {
  it("send the answer as JSON text and as structured content", () => {
    const answer = envelope({ apps: [{ id: "a" }] }, { notes: ["n"] })
    const result = toolResult(answer)
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual(answer)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(answer) }])
  })

  it("pass a ToolError's message to the agent as it is", () => {
    expect(toolError("list_apps", new ToolError("Unknown app id: x."))).toEqual({ content: [{ type: "text", text: "Unknown app id: x." }], isError: true })
  })

  it("explain a statement stopped by the timeout, also when Drizzle wrapped it", () => {
    const timeout = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
    const wrapped = Object.assign(new Error("Failed query: select 1\nparams: secret-param"), { cause: timeout })
    for (const error of [timeout, wrapped]) {
      expect(toolError("get_metrics", error)).toEqual({ content: [{ type: "text", text: "The query ran for more than 15 seconds and was stopped. Ask for a shorter range or fewer apps." }], isError: true })
    }
  })

  it("keep any other error in the server log, without the query's parameters", () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {})
    const cause = Object.assign(new Error("relation does not exist"), { code: "42P01" })
    const result = toolError("get_metrics", Object.assign(new Error("Failed query: select\nparams: acme.myshopify.com"), { cause }))
    expect(result).toEqual({ content: [{ type: "text", text: "The tool failed on the server, which logged the error. Try again, or with simpler input." }], isError: true })
    expect(logged).toHaveBeenCalledWith("mcp tool failed", { tool: "get_metrics", code: "42P01", error: "relation does not exist" })
    expect(JSON.stringify(logged.mock.calls)).not.toContain("acme.myshopify.com")
  })
})

describe("the tools", () => {
  it("have unique snake_case names, a title, a description and an input schema, without em dashes", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length)
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(["list_apps", "get_definitions"]))
    for (const tool of TOOLS) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/)
      expect(tool.title.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThan(50)
      expect(tool.description).not.toMatch(/[—–]/)
      for (const field of Object.values(tool.input.shape)) expect(field.description, tool.name).toBeTruthy()
    }
  })

  it("need no input but a shop timeline's app and shop: every other field has a default", () => {
    for (const tool of TOOLS) {
      const required = Object.entries(tool.input.shape)
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([name]) => name)
      expect(required, tool.name).toEqual(tool.name === "get_shop_timeline" ? ["app_id", "shop"] : [])
    }
  })

  it("refuse an argument they do not take, naming it and the ones they do", async () => {
    // An agent that wrote range for preset used to get the default 30 days, and no word of it.
    expect(await rpc("tools/call", { name: "get_metrics", arguments: { range: "last_90_days" } })).toMatchObject({
      content: [{ type: "text", text: 'Input validation error: Invalid arguments for tool get_metrics: Unknown argument "range". get_metrics takes app_ids, preset, from, to, compare and metrics.' }],
      isError: true,
    })
    for (const tool of TOOLS) {
      const result = await rpc("tools/call", { name: tool.name, arguments: { range: "last_90_days", period: 7 } })
      expect(result.isError, tool.name).toBe(true)
      const text: string = result.content[0].text
      expect(text, tool.name).toContain('Unknown arguments "range" and "period".')
      const fields = Object.keys(tool.input.shape)
      if (fields.length === 0) expect(text, tool.name).toContain(`${tool.name} takes no arguments.`)
      for (const field of fields) expect(text, tool.name).toContain(field)
    }
  })

  it("tell clients in their schema that they take no other argument", async () => {
    const { tools } = await rpc("tools/list", {})
    expect(tools).toHaveLength(TOOLS.length)
    for (const tool of tools) expect(tool.inputSchema.additionalProperties, tool.name).toBe(false)
  })
})

const NOW = new Date("2026-11-22T10:00:00Z")

function connection(over: Partial<ConnectionOverview> = {}): ConnectionOverview {
  return {
    id: "c1",
    label: "Batin Studio",
    partnerId: "42",
    tokenHint: "abcd",
    apiVersion: "2026-07",
    appGids: [],
    backfillFrom: new Date("2025-01-01T00:00:00Z"),
    paused: false,
    isDemo: false,
    syncRequestedAt: null,
    lastRunAt: NOW,
    lastOkAt: NOW,
    lastError: null,
    earningsError: null,
    legacyError: null,
    createdAt: NOW,
    apps: 2,
    events: 100,
    runs: [],
    ...over,
  }
}

const app = (over: Partial<AppInfo> = {}): AppInfo => ({
  id: "a1",
  connectionId: "c1",
  connectionLabel: "Batin Studio",
  isDemo: false,
  gid: "gid://shopify/App/1",
  label: "Show Discount",
  shopifyName: "Show Discount: Sale Badges",
  displayName: "Show Discount",
  color: null,
  hidden: false,
  createdAt: NOW,
  firstEventAt: new Date("2025-02-01T08:00:00Z"),
  lastEventAt: new Date("2026-11-21T22:00:00Z"),
  derivedAt: NOW,
  ...over,
})

describe("list_apps", () => {
  it("knows whether a connection's token can read earnings, and says null until a sync has shown it", () => {
    expect(earningsReadable(connection())).toBe(true)
    expect(earningsReadable(connection({ earningsError: "ACCESS_DENIED" }))).toBe(false)
    expect(earningsReadable(connection({ lastOkAt: null, lastRunAt: null }))).toBeNull()
    expect(earningsReadable(connection({ lastError: "Partner API answered 500" }))).toBeNull()
    expect(earningsReadable(connection({ isDemo: true, lastOkAt: null }))).toBe(true)
  })

  it("writes each app and connection, with times in UTC and no Partner details", () => {
    const answer = describeApps([app()], [connection()])
    expect(answer.timezone).toBe("UTC")
    expect(answer.data.apps).toEqual([
      {
        id: "a1",
        name: "Show Discount",
        shopify_name: "Show Discount: Sale Badges",
        connection_id: "c1",
        connection: "Batin Studio",
        first_event_at: "2025-02-01T08:00:00.000Z",
        last_event_at: "2026-11-21T22:00:00.000Z",
        last_built_at: "2026-11-22T10:00:00.000Z",
      },
    ])
    expect(answer.data.connections).toEqual([
      {
        id: "c1",
        label: "Batin Studio",
        demo: false,
        paused: false,
        history_from: "2025-01-01T00:00:00.000Z",
        last_sync_at: "2026-11-22T10:00:00.000Z",
        last_attempt_at: "2026-11-22T10:00:00.000Z",
        last_error: null,
        earnings_readable: true,
        earnings_error: null,
        billing_events_error: null,
      },
    ])
    expect(JSON.stringify(answer)).not.toMatch(/partner|tokenHint|abcd/i)
    expect(answer.notes).toEqual(["History starts at each connection's backfill date (history_from): nothing Shopify reported before it was read, so counts from that time are not here."])
  })

  it("notes demo data, failed and missing syncs, paused connections, unreadable earnings and billing screen events", () => {
    const answer = describeApps(
      [],
      [
        connection({ id: "d", label: "Demo organization", isDemo: true, paused: true }),
        connection({ id: "n", label: "New org", lastOkAt: null, lastRunAt: null }),
        connection({ id: "f", label: "Broken org", lastError: "Partner API answered 500" }),
        connection({ id: "p", label: "Paused org", paused: true }),
        connection({ id: "e", label: "No earnings org", earningsError: "ACCESS_DENIED" }),
        connection({ id: "b", label: "No billing org", legacyError: "App.events answered 403" }),
      ]
    )
    expect(answer.notes).toEqual([
      "Demo organization holds demo data made up by the seed-demo command. None of it is real.",
      "New org has not finished a sync yet, so its apps may have no numbers.",
      "The last sync of Broken org failed, so its apps' numbers may be out of date. last_error says why.",
      "Paused org is paused: it does not sync until it is resumed in Settings.",
      "Shopify refused the earnings events to the Partner API token of No earnings org, so gross earnings, fees and net earnings are empty for its apps. MRR, charges and installs do not need them.",
      "The billing screen events of No billing org (charges accepted, declined and expired) could not be read on the last sync. Everything else synced. billing_events_error says why.",
      "History starts at each connection's backfill date (history_from): nothing Shopify reported before it was read, so counts from that time are not here.",
    ])
    expect(answer.data.connections.find((c) => c.id === "b")?.billing_events_error).toBe("App.events answered 403")
  })

  it("says when nothing is connected yet", () => {
    expect(describeApps([], []).notes).toEqual(["Nothing is connected yet. A Shopify Partner API token is added in Settings."])
  })
})

describe("the definitions", () => {
  it("list every metric in the registry once, with its unit and direction", () => {
    const ids = [...Object.keys(METRICS), ...Object.keys(COHORT_METRICS), ...Object.keys(AT_RISK_METRICS)]
    expect(METRIC_DEFINITIONS.map((m) => m.id)).toEqual(ids)
    expect(METRIC_DEFINITIONS.find((m) => m.id === "mrr")).toEqual({ id: "mrr", label: "MRR", group: "range", unit: "US dollars", better_when: "higher", description: METRICS.mrr.description })
    expect(METRIC_DEFINITIONS.find((m) => m.id === "winBackRate")?.group).toBe("cohort")
    expect(METRIC_DEFINITIONS.find((m) => m.id === "mrrSetToEnd")).toMatchObject({ group: "at_risk", unit: "US dollars", better_when: "lower" })
  })

  it("give the conventions as plain sentences", () => {
    expect(CONVENTION_TEXT[0]).toBe("Days are UTC. A day runs from 00:00 to 24:00 UTC and every time in the dashboard is shown in UTC. A range includes both of its end days.")
    for (const text of CONVENTION_TEXT) expect(text).not.toContain("**")
  })

  it("as markdown, carry every metric's id and definition, without em dashes", () => {
    const markdown = renderDefinitionsMarkdown()
    for (const m of METRIC_DEFINITIONS) expect(markdown).toContain(`| ${m.id} | ${m.label} | ${m.description} |`)
    expect(markdown).toContain("except revenue retention by cohort, shops won back, win-back rate and time to return, which follow")
    expect(markdown).toContain("and MRR set to end, trials ending soon and frozen MRR, which are read for the moment you ask.")
    expect(markdown).not.toMatch(/[—–]/)
  })
})
