import { describe, expect, it } from "vitest"
import { KEY_MAX_FAILURES, KEY_WINDOW_MS, lockedUntil, retryAfterSeconds, type Attempt } from "@/lib/auth/rate-limit-core"

const MIN = 60_000
const NOW = 1_800_000_000_000
const fail = (agoMs: number): Attempt => ({ at: NOW - agoMs, ok: false })
const ok = (agoMs: number): Attempt => ({ at: NOW - agoMs, ok: true })

describe("lockedUntil", () => {
  it("lets a key with no history try", () => {
    expect(lockedUntil([], NOW)).toBeNull()
  })

  it("lets a key try until it has used its failures", () => {
    const four = [1, 2, 3, 4].map((m) => fail(m * MIN))
    expect(lockedUntil(four, NOW)).toBeNull()
  })

  it("locks at the fifth failure, until the oldest of the five leaves the window", () => {
    const five = [1, 2, 3, 4, 5].map((m) => fail(m * MIN))
    expect(lockedUntil(five, NOW)).toBe(NOW - 5 * MIN + KEY_WINDOW_MS)
  })

  it("unlocks once that failure is older than the window", () => {
    const five = [1, 2, 3, 4, 5].map((m) => fail(m * MIN))
    expect(lockedUntil(five, NOW + KEY_WINDOW_MS - 5 * MIN + 1)).toBeNull()
  })

  it("ignores failures older than the window", () => {
    const old = Array.from({ length: 10 }, (_, i) => fail(KEY_WINDOW_MS + (i + 1) * MIN))
    expect(lockedUntil(old, NOW)).toBeNull()
  })

  it("forgets earlier failures after a success", () => {
    const history = [fail(9 * MIN), fail(8 * MIN), fail(7 * MIN), fail(6 * MIN), fail(5 * MIN), ok(4 * MIN), fail(1 * MIN)]
    expect(lockedUntil(history, NOW)).toBeNull()
  })

  it("keeps counting failures that came after a success", () => {
    const history = [ok(20 * MIN), ...[1, 2, 3, 4, 5].map((m) => fail(m * MIN))]
    expect(lockedUntil(history, NOW)).not.toBeNull()
  })

  it("is a sliding window: the sixth failure extends the lock", () => {
    const six = [0.5, 1, 2, 3, 4, 5].map((m) => fail(m * MIN))
    expect(lockedUntil(six, NOW)).toBe(NOW - 4 * MIN + KEY_WINDOW_MS)
  })

  it("takes the limit and window as parameters, for the global limit", () => {
    const thirty = Array.from({ length: 30 }, (_, i) => fail((i + 1) * 1000))
    expect(lockedUntil(thirty, NOW, 30, 60 * MIN)).not.toBeNull()
    expect(lockedUntil(thirty.slice(1), NOW, 30, 60 * MIN)).toBeNull()
  })

  it("uses five failures per fifteen minutes by default", () => {
    expect(KEY_MAX_FAILURES).toBe(5)
    expect(KEY_WINDOW_MS).toBe(15 * MIN)
  })
})

describe("retryAfterSeconds", () => {
  it("is zero when not locked, and at least one second when locked", () => {
    expect(retryAfterSeconds(null, NOW)).toBe(0)
    expect(retryAfterSeconds(NOW + 90_000, NOW)).toBe(90)
    expect(retryAfterSeconds(NOW + 100, NOW)).toBe(1)
    expect(retryAfterSeconds(NOW - 1, NOW)).toBe(1)
  })
})
