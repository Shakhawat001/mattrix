import { describe, expect, it } from "vitest"
import {
  GLOBAL_HARD_MAX_FAILURES,
  GLOBAL_MAX_FAILURES,
  GLOBAL_WINDOW_MS,
  KEY_MAX_FAILURES,
  KEY_WINDOW_MS,
  judgeAttempt,
  type Attempt,
} from "@/lib/auth/rate-limit-core"

const NOW = Date.UTC(2026, 10, 22, 12)
const fails = (n: number, from = NOW - 60_000): Attempt[] => Array.from({ length: n }, (_, i) => ({ at: from + i * 1000, ok: false }))
const none: Attempt[] = []

describe("judging a login attempt", () => {
  it("lets an attempt through when nothing is wrong", () => {
    expect(judgeAttempt({ ip: none, user: none, global: none }, NOW, false)).toEqual({ allowed: true })
  })

  it("refuses an address that has failed five times, whatever else is true", () => {
    const verdict = judgeAttempt({ ip: fails(KEY_MAX_FAILURES), user: none, global: none }, NOW, false)
    expect(verdict.allowed).toBe(false)
  })

  it("does not lock the owner out when someone guesses at the username: a clean address may still try", () => {
    expect(judgeAttempt({ ip: none, user: fails(KEY_MAX_FAILURES * 4), global: fails(20) }, NOW, false)).toEqual({ allowed: true })
  })

  it("gives an address that has already failed no second try while the username is under attack", () => {
    const verdict = judgeAttempt({ ip: fails(1), user: fails(KEY_MAX_FAILURES), global: fails(6) }, NOW, false)
    expect(verdict.allowed).toBe(false)
    // It may try again when its own failure has aged out.
    if (!verdict.allowed) expect(verdict.until).toBe(NOW - 60_000 + KEY_WINDOW_MS)
  })

  it("does the same when the whole site is under attack", () => {
    const attack = { user: none, global: fails(GLOBAL_MAX_FAILURES) }
    expect(judgeAttempt({ ip: none, ...attack }, NOW, false)).toEqual({ allowed: true })
    expect(judgeAttempt({ ip: fails(1), ...attack }, NOW, false).allowed).toBe(false)
  })

  it("counts the attempt being decided when it is already recorded, so the fifth is the last one through", () => {
    // Four earlier failures plus this one, already written: still allowed.
    expect(judgeAttempt({ ip: fails(5), user: fails(5), global: fails(5) }, NOW, true)).toEqual({ allowed: true })
    // Five earlier failures plus this one: refused.
    expect(judgeAttempt({ ip: fails(6), user: fails(6), global: fails(6) }, NOW, true).allowed).toBe(false)
  })

  it("treats a recorded attempt as the address's own, not as an earlier failure, under attack", () => {
    // The only failure on this address is the attempt being decided: it is the address's first try.
    expect(judgeAttempt({ ip: fails(1, NOW), user: fails(10), global: fails(10) }, NOW, true)).toEqual({ allowed: true })
  })

  it("forgets failures from before the last success", () => {
    const ip: Attempt[] = [...fails(KEY_MAX_FAILURES, NOW - 120_000), { at: NOW - 1000, ok: true }]
    expect(judgeAttempt({ ip, user: none, global: none }, NOW, false)).toEqual({ allowed: true })
  })

  it("refuses everyone, clean addresses included, once the whole site passes the hard limit", () => {
    const from = NOW - 30 * 60_000
    const verdict = judgeAttempt({ ip: none, user: none, global: fails(GLOBAL_HARD_MAX_FAILURES, from) }, NOW, false)
    expect(verdict.allowed).toBe(false)
    // It lifts when the oldest of those failures is an hour old.
    if (!verdict.allowed) expect(verdict.until).toBe(from + GLOBAL_WINDOW_MS)
  })

  it("still gives a clean address its one try just below the hard limit", () => {
    const busy = fails(GLOBAL_HARD_MAX_FAILURES - 1, NOW - 30 * 60_000)
    expect(judgeAttempt({ ip: none, user: none, global: busy }, NOW, false)).toEqual({ allowed: true })
  })

  it("counts a recorded attempt toward the hard limit only once", () => {
    const from = NOW - 30 * 60_000
    // The current attempt is the address's only failure and the last of the global ones.
    expect(judgeAttempt({ ip: fails(1, NOW), user: none, global: fails(GLOBAL_HARD_MAX_FAILURES, from) }, NOW, true)).toEqual({ allowed: true })
    expect(judgeAttempt({ ip: fails(1, NOW), user: none, global: fails(GLOBAL_HARD_MAX_FAILURES + 1, from) }, NOW, true).allowed).toBe(false)
  })
})
