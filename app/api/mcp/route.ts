import { getDb } from "@/lib/db/client"
import { getEnv } from "@/lib/env"
import { handleMcpRequest } from "@/lib/mcp/http"

// The MCP endpoint for AI agents (docs/MCP.md). It checks its own API token instead of a session
// (lib/mcp/auth.ts), so the proxy lets it through without a cookie. Everything else is in lib/mcp.
// Only POST: the protocol needs nothing else here, and other methods get 405.

export async function POST(request: Request): Promise<Response> {
  return handleMcpRequest(request, { db: getDb(), secret: getEnv().sessionSecret })
}
