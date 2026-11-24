// At most 120 requests a minute per API token, counted in memory: there is one web container, and
// a restart that forgets the counts does no harm. A refused request is answered 429 with
// Retry-After: no tool runs for it and nothing is written to the call log.

export const MCP_REQUESTS_PER_MINUTE = 120
const WINDOW_MS = 60_000

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** A sliding window per key: it keeps the times of the requests it let through in the last window. Refused requests do not count. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    readonly limit: number = MCP_REQUESTS_PER_MINUTE,
    readonly windowMs: number = WINDOW_MS
  ) {}

  /** Takes `cost` places (a batch takes one for each of its messages): all of them, or none. */
  take(key: string, now: number = Date.now(), cost = 1): RateDecision {
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs)
    if (recent.length + cost > this.limit) {
      this.hits.set(key, recent)
      // Enough places free up when the oldest requests in the window leave it. A cost over the limit never fits.
      const leaving = recent[recent.length + cost - this.limit - 1]
      const freeAt = leaving === undefined ? now + this.windowMs : leaving + this.windowMs
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)) }
    }
    for (let i = 0; i < cost; i++) recent.push(now)
    this.hits.set(key, recent)
    return { allowed: true }
  }
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate_limited", error_description: `At most ${MCP_REQUESTS_PER_MINUTE} requests a minute per token. Try again in ${retryAfterSeconds} seconds.` },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" } }
  )
}

// One per process. In development Next reloads modules, so it lives on globalThis.
const globalForLimiter = globalThis as unknown as { __appmetricsMcpLimiter?: RateLimiter }
export const mcpRateLimiter = (globalForLimiter.__appmetricsMcpLimiter ??= new RateLimiter())
