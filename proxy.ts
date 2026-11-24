import { NextResponse, type NextRequest } from "next/server"

// Runs before every page. Two jobs:
//
//   1. Sets a Content-Security-Policy with a fresh nonce, so only scripts Next.js
//      itself emitted can run. (Pages are rendered per request, which nonces require.)
//   2. Sends visitors with no session cookie to /login. That is a convenience only:
//      it does not check the cookie is valid. Every page, Server Action and route
//      handler checks the session itself (lib/auth/dal.ts).

const COOKIE_NAMES = ["__Host-am_session", "am_session"]
// /api/mcp needs no cookie: it checks its own API token (lib/mcp/auth.ts).
const PUBLIC_PATHS = new Set(["/login", "/api/health", "/api/mcp"])

function httpsDeployment(): boolean {
  const explicit = process.env.COOKIE_SECURE?.trim().toLowerCase()
  if (explicit) return ["true", "1", "yes", "on"].includes(explicit)
  return process.env.NODE_ENV === "production"
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64")
  const dev = process.env.NODE_ENV === "development"

  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // Charts and menus set inline style attributes; a nonce cannot cover those.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Only where the site is served over https; on plain http it would break every asset.
    ...(httpsDeployment() && !dev ? ["upgrade-insecure-requests"] : []),
  ].join("; ")

  const { pathname, search } = request.nextUrl
  const signedIn = COOKIE_NAMES.some((name) => request.cookies.has(name))

  if (!signedIn && !PUBLIC_PATHS.has(pathname) && (request.method === "GET" || request.method === "HEAD")) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } })
    }
    const login = new URL("/login", request.url)
    if (pathname !== "/") login.searchParams.set("next", pathname + search)
    return NextResponse.redirect(login)
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("Content-Security-Policy", policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set("Content-Security-Policy", policy)
  return response
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
}
