import { afterEach, describe, expect, it, vi } from "vitest"
import type { Db } from "@/lib/db/client"
import { log } from "@/lib/log"
import { createContext } from "@/lib/mcp/context"
import { shopAlias } from "@/lib/mcp/output"
import { mcpHandler, toAuthInfo } from "@/lib/mcp/server"

// The server's handling of every tool, through the SDK's real handler: the shop aliases, the
// errors, the annotations. The tool list is swapped for tools made for the test.

vi.mock("@/lib/mcp/tools", async () => {
  const { z } = await import("zod")
  const { defineTool, ToolError } = await import("@/lib/mcp/tool")
  const { envelope } = await import("@/lib/mcp/output")
  const input = z.object({})
  return {
    shopsTool: defineTool({
      name: "test_shops",
      title: "Shops",
      description: "Answers with a shop, a merchant's comment, a sync error and a note that name shops.",
      input,
      run: async () =>
        envelope(
          { rows: [{ shop: "acme.myshopify.com", merchant_text_untrusted: "We closed acme.myshopify.com." }], last_error: "Shop beta.myshopify.com could not be read." },
          { notes: ["Read Beta.MyShopify.com again."] }
        ),
    }),
    refusingTool: defineTool({
      name: "test_refuses",
      title: "Refuses",
      description: "Refuses, as a tool does for an unknown id.",
      input,
      run: async () => {
        throw new ToolError("Unknown app id: x. list_apps gives the ids.")
      },
    }),
    refusingShopTool: defineTool({
      name: "test_refuses_shop",
      title: "Refuses a shop",
      description: "Refuses with a message that names a shop.",
      input,
      run: async () => {
        throw new ToolError("acme.myshopify.com has no stays.")
      },
    }),
    brokenTool: defineTool({
      name: "test_breaks",
      title: "Breaks",
      description: "Fails the way a bug does.",
      input,
      run: async () => {
        throw new Error("Cannot read properties of undefined")
      },
    }),
  }
})

const SECRET = "a-session-secret-that-is-long-enough-123456"
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} }

async function send(method: string, params: Record<string, unknown>, hideShops = false) {
  const ctx = createContext({ db: {} as Db, secret: SECRET, token: { id: "token-1", name: "Test", hideShops } })
  const body = { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method }
  if (typeof params.name === "string") headers["mcp-name"] = params.name
  const response = await mcpHandler().fetch(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify(body) }), { authInfo: toAuthInfo(ctx), parsedBody: body })
  expect(response.status).toBe(200)
  return (await response.json()).result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("the MCP server", () => {
  it("marks every tool read-only, idempotent and closed to the outside world", async () => {
    const { tools } = await send("tools/list", {})
    expect(tools.map((t: { name: string }) => t.name)).toEqual(["test_breaks", "test_refuses", "test_refuses_shop", "test_shops"])
    for (const tool of tools) expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true, openWorldHint: false })
  })

  it("shows shop domains to a token that does not hide them", async () => {
    const result = await send("tools/call", { name: "test_shops", arguments: {} })
    expect(result.structuredContent.data).toEqual({ rows: [{ shop: "acme.myshopify.com", merchant_text_untrusted: "We closed acme.myshopify.com." }], last_error: "Shop beta.myshopify.com could not be read." })
    expect(result.structuredContent.notes).toEqual(["Read Beta.MyShopify.com again."])
    expect((await send("tools/call", { name: "test_refuses_shop", arguments: {} })).content[0].text).toBe("acme.myshopify.com has no stays.")
  })

  it("replaces every shop domain with its alias for a token that hides them, in any field, in the text and in the structured answer", async () => {
    const result = await send("tools/call", { name: "test_shops", arguments: {} }, true)
    const [acme, beta] = [shopAlias(SECRET, "acme.myshopify.com"), shopAlias(SECRET, "beta.myshopify.com")]
    expect(result.structuredContent.data).toEqual({ rows: [{ shop: acme, merchant_text_untrusted: `We closed ${acme}.` }], last_error: `Shop ${beta} could not be read.` })
    expect(result.structuredContent.notes).toEqual([`Read ${beta} again.`])
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    expect(JSON.stringify(result)).not.toMatch(/acme|beta/i)
  })

  it("replaces shop domains in a tool's error too, for a token that hides them", async () => {
    const result = await send("tools/call", { name: "test_refuses_shop", arguments: {} }, true)
    expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: `${shopAlias(SECRET, "acme.myshopify.com")} has no stays.` }] })
  })

  it("gives the agent a ToolError's message, and only a generic one for anything else", async () => {
    const logged = vi.spyOn(log, "error").mockImplementation(() => {})
    expect(await send("tools/call", { name: "test_refuses", arguments: {} })).toMatchObject({ isError: true, content: [{ type: "text", text: "Unknown app id: x. list_apps gives the ids." }] })
    const broken = await send("tools/call", { name: "test_breaks", arguments: {} })
    expect(broken).toMatchObject({ isError: true, content: [{ type: "text", text: "The tool failed on the server, which logged the error. Try again, or with simpler input." }] })
    expect(JSON.stringify(broken)).not.toContain("Cannot read")
    expect(logged).toHaveBeenCalledWith("mcp tool failed", { tool: "test_breaks", code: undefined, error: "Cannot read properties of undefined" })
  })
})
