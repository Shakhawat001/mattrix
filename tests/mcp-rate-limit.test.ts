import { describe, expect, it } from "vitest"
import { MCP_REQUESTS_PER_MINUTE, RateLimiter, tooManyRequests } from "@/lib/mcp/rate-limit"

const T0 = 1_000_000

describe("RateLimiter", () => {
  it("lets 120 requests a minute through and refuses the next, saying when to retry", () => {
    expect(MCP_REQUESTS_PER_MINUTE).toBe(120)
    const limiter = new RateLimiter()
    for (let i = 0; i < 120; i++) expect(limiter.take("token", T0 + i * 100)).toEqual({ allowed: true })
    // The first request leaves the window at T0 + 60s; it is now T0 + 12s.
    expect(limiter.take("token", T0 + 12_000)).toEqual({ allowed: false, retryAfterSeconds: 48 })
  })

  it("frees a place as soon as the oldest request leaves the window", () => {
    const limiter = new RateLimiter(3, 60_000)
    limiter.take("token", T0)
    limiter.take("token", T0 + 10_000)
    limiter.take("token", T0 + 20_000)
    expect(limiter.take("token", T0 + 59_999).allowed).toBe(false)
    expect(limiter.take("token", T0 + 60_000).allowed).toBe(true)
    expect(limiter.take("token", T0 + 60_001)).toEqual({ allowed: false, retryAfterSeconds: 10 })
  })

  it("does not count refused requests, so waiting is enough", () => {
    const limiter = new RateLimiter(2, 60_000)
    limiter.take("token", T0)
    limiter.take("token", T0 + 1)
    for (let i = 0; i < 50; i++) expect(limiter.take("token", T0 + 1000 + i).allowed).toBe(false)
    expect(limiter.take("token", T0 + 60_001).allowed).toBe(true)
  })

  it("counts each token on its own", () => {
    const limiter = new RateLimiter(1, 60_000)
    expect(limiter.take("a", T0).allowed).toBe(true)
    expect(limiter.take("a", T0).allowed).toBe(false)
    expect(limiter.take("b", T0).allowed).toBe(true)
  })

  it("never asks to wait less than a second", () => {
    const limiter = new RateLimiter(1, 60_000)
    limiter.take("token", T0)
    expect(limiter.take("token", T0 + 59_999)).toEqual({ allowed: false, retryAfterSeconds: 1 })
  })
})

describe("tooManyRequests", () => {
  it("is a 429 with Retry-After", async () => {
    const response = tooManyRequests(17)
    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("17")
    expect(await response.json()).toEqual({ error: "rate_limited", error_description: "At most 120 requests a minute per token. Try again in 17 seconds." })
  })
})
