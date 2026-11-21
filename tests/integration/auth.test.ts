import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { checkLoginAllowed, loginKeys, recordLoginAttempt, reserveLoginAttempt } from "@/lib/auth/rate-limit"
import {
  ABSOLUTE_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
  countActiveSessions,
  createSession,
  destroyAllSessions,
  destroySession,
  findSession,
  purgeExpiredSessions,
} from "@/lib/auth/sessions"
import type { Database } from "@/lib/db/client"
import { loginAttempts, sessions } from "@/lib/db/schema"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const SECRET = "a-session-secret-that-is-long-enough-123456"
const HOUR = 3_600_000
const T0 = new Date("2026-11-22T10:00:00Z")
const later = (ms: number) => new Date(T0.getTime() + ms)

describe.skipIf(!hasDatabase)("sessions (Postgres)", () => {
  let database: Database
  beforeAll(async () => {
    database = await openTestDatabase()
  })
  beforeEach(() => clearAll(database))
  afterAll(() => database.close())

  it("gives the browser a random token and stores only a hash of it", async () => {
    const { token, expiresAt } = await createSession(database.db, SECRET, { ip: "203.0.113.5", userAgent: "TestAgent" }, T0)
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(expiresAt.getTime()).toBe(T0.getTime() + ABSOLUTE_TIMEOUT_MS)

    const stored = JSON.stringify(await database.db.select().from(sessions))
    expect(stored).not.toContain(token)
    expect(stored).toContain("203.0.113.5")
  })

  it("finds a live session by its token and refuses anything else", async () => {
    const { token } = await createSession(database.db, SECRET, {}, T0)
    expect(await findSession(database.db, SECRET, token, later(HOUR))).not.toBeNull()
    expect(await findSession(database.db, SECRET, "x".repeat(43), later(HOUR))).toBeNull()
    expect(await findSession(database.db, SECRET, "short", later(HOUR))).toBeNull()
    expect(await findSession(database.db, SECRET, "", later(HOUR))).toBeNull()
    expect(await findSession(database.db, SECRET, `${token}'; DROP TABLE sessions;--`, later(HOUR))).toBeNull()
  })

  it("does not recognize the token under a different secret", async () => {
    const { token } = await createSession(database.db, SECRET, {}, T0)
    expect(await findSession(database.db, "another-secret-that-is-also-long-enough-9876", token, later(HOUR))).toBeNull()
  })

  it("ends a session after a day of inactivity, and removes it", async () => {
    const { token } = await createSession(database.db, SECRET, {}, T0)
    expect(await findSession(database.db, SECRET, token, later(IDLE_TIMEOUT_MS - HOUR))).not.toBeNull()
    expect(await findSession(database.db, SECRET, token, later(IDLE_TIMEOUT_MS - HOUR + IDLE_TIMEOUT_MS + 1))).toBeNull()
    expect(await database.db.select().from(sessions)).toHaveLength(0)
  })

  it("keeps an active session alive, but not past a week in total", async () => {
    const { token } = await createSession(database.db, SECRET, {}, T0)
    for (let hours = 20; hours < 7 * 24; hours += 20) {
      expect(await findSession(database.db, SECRET, token, later(hours * HOUR))).not.toBeNull()
    }
    expect(await findSession(database.db, SECRET, token, later(ABSOLUTE_TIMEOUT_MS + HOUR))).toBeNull()
  })

  it("touches the last-seen time only now and then, not on every request", async () => {
    const { token } = await createSession(database.db, SECRET, {}, T0)
    await findSession(database.db, SECRET, token, later(60_000))
    const [soon] = await database.db.select({ at: sessions.lastSeenAt }).from(sessions)
    expect(soon.at.getTime()).toBe(T0.getTime())
    await findSession(database.db, SECRET, token, later(10 * 60_000))
    const [after] = await database.db.select({ at: sessions.lastSeenAt }).from(sessions)
    expect(after.at.getTime()).toBe(later(10 * 60_000).getTime())
  })

  it("logs one browser out without touching another", async () => {
    const a = await createSession(database.db, SECRET, {}, T0)
    const b = await createSession(database.db, SECRET, {}, T0)
    await destroySession(database.db, SECRET, a.token)
    expect(await findSession(database.db, SECRET, a.token, later(HOUR))).toBeNull()
    expect(await findSession(database.db, SECRET, b.token, later(HOUR))).not.toBeNull()
  })

  it("logs every browser out at once", async () => {
    await createSession(database.db, SECRET, {}, T0)
    await createSession(database.db, SECRET, {}, T0)
    expect(await destroyAllSessions(database.db)).toBe(2)
    expect(await countActiveSessions(database.db, later(HOUR))).toBe(0)
  })

  it("purges expired and idle sessions and keeps live ones", async () => {
    await createSession(database.db, SECRET, {}, T0) // idle by the time of the purge
    const live = await createSession(database.db, SECRET, {}, later(2 * IDLE_TIMEOUT_MS))
    await purgeExpiredSessions(database.db, later(2 * IDLE_TIMEOUT_MS + HOUR))
    expect(await database.db.select().from(sessions)).toHaveLength(1)
    expect(await findSession(database.db, SECRET, live.token, later(2 * IDLE_TIMEOUT_MS + HOUR))).not.toBeNull()
  })
})

describe.skipIf(!hasDatabase)("login throttling (Postgres)", () => {
  let database: Database
  beforeAll(async () => {
    database = await openTestDatabase()
  })
  beforeEach(() => clearAll(database))
  afterAll(() => database.close())

  const NOW = T0.getTime()
  const fail = (keys: string[], at: number) => recordLoginAttempt(database.db, keys, false, at)

  it("lets a first attempt through, and four failures", async () => {
    const keys = loginKeys("203.0.113.5", "owner")
    expect(await checkLoginAllowed(database.db, keys, NOW)).toEqual({ allowed: true })
    for (let i = 0; i < 4; i++) await fail(keys, NOW - (4 - i) * 60_000)
    expect(await checkLoginAllowed(database.db, keys, NOW)).toEqual({ allowed: true })
  })

  it("blocks at the fifth failure and says how long to wait", async () => {
    const keys = loginKeys("203.0.113.5", "owner")
    for (let i = 0; i < 5; i++) await fail(keys, NOW - (5 - i) * 60_000)
    const gate = await checkLoginAllowed(database.db, keys, NOW)
    expect(gate.allowed).toBe(false)
    if (!gate.allowed) expect(gate.retryAfterSeconds).toBe(10 * 60) // 5 minutes ago + 15 minute window
  })

  it("lets the key try again once the window has passed", async () => {
    const keys = loginKeys("203.0.113.5", "owner")
    for (let i = 0; i < 5; i++) await fail(keys, NOW - (5 - i) * 60_000)
    expect(await checkLoginAllowed(database.db, keys, NOW + 11 * 60_000)).toEqual({ allowed: true })
  })

  it("does not let anyone lock the owner out by guessing at the username", async () => {
    for (let i = 0; i < 5; i++) await fail(loginKeys(`198.51.100.${i}`, "owner"), NOW - (5 - i) * 1000)
    // The owner, from an address with no failures, may still try.
    expect(await checkLoginAllowed(database.db, loginKeys("203.0.113.99", "owner"), NOW)).toEqual({ allowed: true })
    expect(await reserveLoginAttempt(database.db, loginKeys("203.0.113.99", "owner"), NOW)).toEqual({ allowed: true })
  })

  it("gives an address that already failed no second try while the username is under attack", async () => {
    for (let i = 0; i < 5; i++) await fail(loginKeys(`198.51.100.${i}`, "owner"), NOW - (5 - i) * 1000)
    expect((await checkLoginAllowed(database.db, loginKeys("198.51.100.0", "owner"), NOW)).allowed).toBe(false)
  })

  it("blocks an address that is trying many usernames", async () => {
    for (let i = 0; i < 5; i++) await fail(loginKeys("203.0.113.7", `guess${i}`), NOW - (5 - i) * 1000)
    expect((await checkLoginAllowed(database.db, loginKeys("203.0.113.7", "owner"), NOW)).allowed).toBe(false)
  })

  it("does not block someone else for it", async () => {
    for (let i = 0; i < 5; i++) await fail(loginKeys("203.0.113.7", "owner"), NOW - (5 - i) * 1000)
    expect(await checkLoginAllowed(database.db, loginKeys("203.0.113.8", "someoneelse"), NOW)).toEqual({ allowed: true })
  })

  it("gives each address one try while the whole site is under attack", async () => {
    for (let i = 0; i < 30; i++) await fail(loginKeys(`192.0.2.${i}`, `name${i}`), NOW - (30 - i) * 1000)
    expect(await checkLoginAllowed(database.db, loginKeys("203.0.113.200", "fresh"), NOW)).toEqual({ allowed: true })
    expect((await checkLoginAllowed(database.db, loginKeys("192.0.2.3", "fresh"), NOW)).allowed).toBe(false)
  })

  it("counts guesses sent at the same moment against each other", async () => {
    // Twenty attempts from one address at once: each is recorded before it is decided, so at most five get through.
    const keys = loginKeys("203.0.113.50", "owner")
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveLoginAttempt(database.db, keys, NOW)))
    expect(results.filter((r) => r.allowed).length).toBeLessThanOrEqual(5)
    expect(await database.db.select().from(loginAttempts)).toHaveLength(20 * 3)
  })

  it("lets a correct password through after a reservation, and the success clears the slate", async () => {
    const keys = loginKeys("203.0.113.60", "owner")
    for (let i = 0; i < 4; i++) await fail(keys, NOW - (10 - i) * 1000)
    expect(await reserveLoginAttempt(database.db, keys, NOW - 2000)).toEqual({ allowed: true })
    await recordLoginAttempt(database.db, keys, true, NOW - 1000)
    expect(await checkLoginAllowed(database.db, keys, NOW)).toEqual({ allowed: true })
  })

  it("forgets earlier failures after a success", async () => {
    const keys = loginKeys("203.0.113.5", "owner")
    for (let i = 0; i < 4; i++) await fail(keys, NOW - (10 - i) * 1000)
    await recordLoginAttempt(database.db, keys, true, NOW - 5000)
    await fail(keys, NOW - 1000)
    expect(await checkLoginAllowed(database.db, keys, NOW)).toEqual({ allowed: true })
  })

  it("keys the username by a hash, not by what the attacker typed", async () => {
    await fail(loginKeys("203.0.113.5", "Robert'); DROP TABLE users;--"), NOW)
    const stored = JSON.stringify(await database.db.select().from(loginAttempts))
    expect(stored).not.toContain("DROP TABLE")
  })

  it("treats a username's case and spacing as the same name", () => {
    expect(loginKeys("1.1.1.1", " Owner ")).toEqual(loginKeys("1.1.1.1", "owner"))
  })

  it("counts the addresses in one IPv6 /64 as one address", async () => {
    for (let i = 1; i <= 5; i++) await fail(loginKeys(`2001:db8:1:2::${i}`, "owner"), NOW - (10 - i) * 1000)
    expect((await checkLoginAllowed(database.db, loginKeys("2001:db8:1:2::99", "owner"), NOW)).allowed).toBe(false)
    expect(await checkLoginAllowed(database.db, loginKeys("2001:db8:1:3::1", "owner"), NOW)).toEqual({ allowed: true })
  })

  it("refuses everyone once failures across the site pass the hard limit", async () => {
    for (let i = 0; i < 100; i++) await fail(loginKeys(`192.0.2.${i}`, `name${i}`), NOW - (200 - i) * 1000)
    expect((await checkLoginAllowed(database.db, loginKeys("203.0.113.201", "owner"), NOW)).allowed).toBe(false)
  })

  it("discards attempts older than a day", async () => {
    await fail(loginKeys("203.0.113.5", "owner"), NOW - 25 * HOUR)
    await fail(loginKeys("203.0.113.5", "owner"), NOW)
    const rows = await database.db.select().from(loginAttempts)
    expect(rows.every((r) => r.at.getTime() >= NOW - 24 * HOUR)).toBe(true)
  })
})
