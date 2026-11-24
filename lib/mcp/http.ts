import { originValidationResponse, readRequestBody } from "@modelcontextprotocol/server"
import { recordApiCall } from "@/lib/auth/api-tokens"
import type { Db } from "@/lib/db/client"
import { log } from "@/lib/log"
import { authenticate } from "./auth"
import { createContext } from "./context"
import { mcpRateLimiter, tooManyRequests, type RateLimiter } from "./rate-limit"
import { errorCause, mcpHandler, toAuthInfo } from "./server"

// One request to /api/mcp, start to finish:
//
//   1. A request sent by a web page (it carries an Origin header) is refused: only agents call
//      this, and the MCP spec asks servers to refuse origins they do not expect.
//   2. The bearer token is checked, which also records its last use (lib/mcp/auth.ts).
//   3. The token's rate limit (lib/mcp/rate-limit.ts).
//   4. The body is read, at most 1 MiB, and parsed, so the call log can say what was asked.
//   5. The SDK answers it with a server built for this request (lib/mcp/server.ts). Tools read
//      only through ctx.read(), a read-only transaction.
//   6. The call goes in the call log (api_calls), on the pool, outside any read-only transaction.

const MAX_BODY_BYTES = 1024 * 1024

export type McpDeps = { db: Db; secret: string; limiter?: RateLimiter }

export async function handleMcpRequest(request: Request, deps: McpDeps): Promise<Response> {
  const started = performance.now()
  const refused = originValidationResponse(request, [])
  if (refused) {
    refused.headers.set("Cache-Control", "no-store")
    return refused
  }

  try {
    const now = new Date()
    const gate = await authenticate(request, deps.db, deps.secret, now)
    if (!gate.ok) return gate.response
    const tokenId = gate.caller.id

    const limit = (deps.limiter ?? mcpRateLimiter).take(tokenId, now.getTime())
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds)

    const logged = async (tool: string, ok: boolean, response: Response): Promise<Response> => {
      try {
        await recordApiCall(deps.db, { tokenId, tool, ok, durationMs: performance.now() - started }, now)
      } catch (error) {
        log.warn("mcp call not logged", { error: errorCause(error).message })
      }
      return response
    }

    const read = await readRequestBody(request, MAX_BODY_BYTES)
    if (read.tooLarge) return logged("invalid", false, jsonRpcError(413, -32000, `The request body is over ${MAX_BODY_BYTES} bytes.`))
    let body: unknown
    try {
      body = JSON.parse(read.text)
    } catch {
      return logged("invalid", false, jsonRpcError(400, -32700, "Parse error: the request body is not JSON."))
    }

    const call = describeCall(body)
    const context = createContext({ db: deps.db, secret: deps.secret, token: gate.caller, now })
    const response = await mcpHandler().fetch(request, { authInfo: toAuthInfo(context), parsedBody: body })
    // A listen stream stays open for as long as the client keeps it, so it is passed on as it is.
    if (call === "subscriptions/listen") return logged(call, response.ok, response)
    const text = await response.text()
    return logged(call, !exchangeFailed(response.status, response.headers.get("content-type"), text), withNoStore(response, text))
  } catch (error) {
    log.error("mcp request failed", { error: errorCause(error).message })
    return jsonRpcError(500, -32603, "Internal error.")
  }
}

/** What a request asks for, for the call log: the tool's name for a tools/call, otherwise the JSON-RPC method. */
export function describeCall(body: unknown): string {
  if (Array.isArray(body)) return "batch"
  if (!isObject(body) || typeof body.method !== "string") return "invalid"
  const tool = body.method === "tools/call" && isObject(body.params) && typeof body.params.name === "string" ? body.params.name : null
  return (tool ?? body.method).replace(/[^\w./-]/g, "_").slice(0, 64) || "invalid"
}

/** Whether an answered request failed: an HTTP error, a JSON-RPC error, or a tool result marked isError. The body is JSON or server-sent events. */
export function exchangeFailed(status: number, contentType: string | null, body: string): boolean {
  if (status >= 400) return true
  const messages = contentType?.includes("text/event-stream") ? eventData(body) : [body]
  return messages.some((text) => {
    try {
      return carriesError(JSON.parse(text))
    } catch {
      return false
    }
  })
}

const carriesError = (message: unknown): boolean =>
  Array.isArray(message) ? message.some(carriesError) : isObject(message) && ("error" in message || (isObject(message.result) && message.result.isError === true))

/** The data of each server-sent event: its `data:` lines joined, events being separated by a blank line. */
function eventData(body: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
    )
    .filter((data) => data !== "")
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status, headers: { "Cache-Control": "no-store" } })
}

/** The SDK's answer with its body read, and marked not to be cached. */
function withNoStore(response: Response, body: string): Response {
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "no-store")
  return new Response(body === "" ? null : body, { status: response.status, statusText: response.statusText, headers })
}
