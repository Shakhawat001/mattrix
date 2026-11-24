import { verifyApiToken, type ApiCaller } from "@/lib/auth/api-tokens"
import { BRAND } from "@/lib/brand"
import type { Db } from "@/lib/db/client"

// The MCP endpoint's gate, in place of requireSession(): every request carries an API token from
// Settings as `Authorization: Bearer <token>`. A token in the URL is never read, since URLs end up
// in proxy and browser logs. Checking a token writes its last use, so it runs on the pool, before
// and outside the read-only transaction tools read in. The token goes no further than this file:
// what follows knows only the token's id, name and settings, and nothing logs it.

/** The token in an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer +([^\s,]+)$/i.exec(header?.trim() ?? "")
  return match ? match[1] : null
}

/** 401 with the `WWW-Authenticate: Bearer` challenge (RFC 6750): no error code when no token was sent, invalid_token when it was refused. */
export function unauthorized(problem: "missing" | "invalid"): Response {
  const description = problem === "missing" ? "Send an API token from Settings as Authorization: Bearer <token>." : "The token is unknown, revoked or expired."
  const challenge = problem === "missing" ? `Bearer realm="${BRAND.name}"` : `Bearer realm="${BRAND.name}", error="invalid_token", error_description="${description}"`
  return Response.json(
    { error: problem === "missing" ? "unauthorized" : "invalid_token", error_description: description },
    { status: 401, headers: { "WWW-Authenticate": challenge, "Cache-Control": "no-store" } }
  )
}

export type Gate = { ok: true; caller: ApiCaller } | { ok: false; response: Response }

/** Who is calling, or the 401 to answer with. */
export async function authenticate(request: Request, db: Db, secret: string, now: Date = new Date()): Promise<Gate> {
  const token = bearerToken(request.headers.get("authorization"))
  if (!token) return { ok: false, response: unauthorized("missing") }
  const caller = await verifyApiToken(db, secret, token, now)
  return caller ? { ok: true, caller } : { ok: false, response: unauthorized("invalid") }
}
