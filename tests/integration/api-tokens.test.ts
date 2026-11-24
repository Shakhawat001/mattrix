import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  MAX_ACTIVE_API_TOKENS,
  createApiToken,
  hashApiToken,
  listApiTokens,
  purgeOldApiCalls,
  revokeApiToken,
  verifyApiToken,
  type NewApiToken,
} from "@/lib/auth/api-tokens"
import type { Database } from "@/lib/db/client"
import { apiCalls, apiTokens } from "@/lib/db/schema"
import { clearAll, hasDatabase, openTestDatabase } from "../helpers/db"

const SECRET = "a-session-secret-that-is-long-enough-123456"
const DAY = 86_400_000
const T0 = new Date("2026-11-22T10:00:00Z")
const later = (ms: number) => new Date(T0.getTime() + ms)
const plain: NewApiToken = { name: "Claude Code", expiresInDays: null, hideShops: false }

describe.skipIf(!hasDatabase)("API tokens (Postgres)", () => {
  let database: Database
  beforeAll(async () => {
    database = await openTestDatabase()
  })
  beforeEach(() => clearAll(database))
  afterAll(() => database.close())

  async function create(input: Partial<NewApiToken> = {}, at: Date = T0): Promise<{ id: string; token: string }> {
    const created = await createApiToken(database.db, SECRET, { ...plain, ...input }, at)
    if (!created.ok) throw new Error("expected the token to be created")
    return created
  }
  const rowOf = async (id: string) => (await database.db.select().from(apiTokens).where(eq(apiTokens.id, id)))[0]

  describe("creating", () => {
    it("returns the token once and stores only its HMAC and its last four characters", async () => {
      const { id, token } = await create({ name: "Cursor" })
      expect(token).toMatch(/^amt_[\w-]{43}$/)

      const row = await rowOf(id)
      expect(row).toMatchObject({ name: "Cursor", tokenHash: hashApiToken(SECRET, token), hint: token.slice(-4), hideShops: false, lastUsedAt: null, expiresAt: null, revokedAt: null })
      expect(row.createdAt.toISOString()).toBe(T0.toISOString())
      const stored = JSON.stringify(await database.db.select().from(apiTokens))
      expect(stored).not.toContain(token)
      expect(stored).not.toContain(token.slice(4, -4))
    })

    it("sets the expiry that many days ahead, and keeps the choice to hide shop domains", async () => {
      const { id } = await create({ expiresInDays: 30, hideShops: true })
      const row = await rowOf(id)
      expect(row.expiresAt?.toISOString()).toBe(later(30 * DAY).toISOString())
      expect(row.hideShops).toBe(true)
    })
  })

  describe("verifying", () => {
    it("knows a live token and who it belongs to", async () => {
      const { id, token } = await create({ name: "Codex", hideShops: true })
      expect(await verifyApiToken(database.db, SECRET, token, later(1000))).toEqual({ id, name: "Codex", hideShops: true })
    })

    it("refuses an unknown token, a malformed one, and one checked under another secret", async () => {
      const { token } = await create()
      const other = `amt_${"A".repeat(43)}`
      expect(await verifyApiToken(database.db, SECRET, other, T0)).toBeNull()
      expect(await verifyApiToken(database.db, SECRET, "", T0)).toBeNull()
      expect(await verifyApiToken(database.db, SECRET, token.slice(0, -1), T0)).toBeNull()
      expect(await verifyApiToken(database.db, SECRET, `${token}'; DROP TABLE api_tokens;--`, T0)).toBeNull()
      expect(await verifyApiToken(database.db, "another-secret-that-is-also-long-enough-9876", token, T0)).toBeNull()
    })

    it("refuses a token from the moment it expires", async () => {
      const { token } = await create({ expiresInDays: 30 })
      expect(await verifyApiToken(database.db, SECRET, token, later(30 * DAY - 1))).not.toBeNull()
      expect(await verifyApiToken(database.db, SECRET, token, later(30 * DAY))).toBeNull()
      expect(await verifyApiToken(database.db, SECRET, token, later(31 * DAY))).toBeNull()
    })

    it("never expires a token made without an expiry", async () => {
      const { token } = await create({ expiresInDays: null })
      expect(await verifyApiToken(database.db, SECRET, token, later(5 * 365 * DAY))).not.toBeNull()
    })

    it("records the last use at most once a minute", async () => {
      const { id, token } = await create()
      await verifyApiToken(database.db, SECRET, token, later(1000))
      expect((await rowOf(id)).lastUsedAt?.toISOString()).toBe(later(1000).toISOString())

      await verifyApiToken(database.db, SECRET, token, later(40_000))
      expect((await rowOf(id)).lastUsedAt?.toISOString()).toBe(later(1000).toISOString())

      await verifyApiToken(database.db, SECRET, token, later(61_000))
      expect((await rowOf(id)).lastUsedAt?.toISOString()).toBe(later(61_000).toISOString())
    })

    it("does not mark a refused token as used", async () => {
      const { id, token } = await create({ expiresInDays: 30 })
      await verifyApiToken(database.db, SECRET, token, later(31 * DAY))
      expect((await rowOf(id)).lastUsedAt).toBeNull()
    })
  })

  describe("revoking", () => {
    it("refuses a revoked token at once, and leaves the others working", async () => {
      const a = await create({ name: "a" })
      const b = await create({ name: "b" })
      expect(await revokeApiToken(database.db, a.id, later(1000))).toBe(true)
      expect(await verifyApiToken(database.db, SECRET, a.token, later(2000))).toBeNull()
      expect(await verifyApiToken(database.db, SECRET, b.token, later(2000))).not.toBeNull()
      expect((await rowOf(a.id)).revokedAt?.toISOString()).toBe(later(1000).toISOString())
      expect((await rowOf(a.id)).lastUsedAt).toBeNull()
    })

    it("says so when there was nothing to revoke", async () => {
      const { id } = await create()
      expect(await revokeApiToken(database.db, id)).toBe(true)
      expect(await revokeApiToken(database.db, id)).toBe(false)
      expect(await revokeApiToken(database.db, "00000000-0000-4000-8000-000000000000")).toBe(false)
    })
  })

  describe("listing", () => {
    it("shows every token not revoked, newest first, expired ones included, and never a hash", async () => {
      const old = await create({ name: "old", expiresInDays: 30 }, T0)
      const gone = await create({ name: "gone" }, later(DAY))
      const fresh = await create({ name: "fresh", hideShops: true }, later(2 * DAY))
      await revokeApiToken(database.db, gone.id)

      const list = await listApiTokens(database.db)
      expect(list.map((t) => t.name)).toEqual(["fresh", "old"])
      expect(list[0]).toEqual({
        id: fresh.id,
        name: "fresh",
        hint: fresh.token.slice(-4),
        hideShops: true,
        createdAt: later(2 * DAY),
        lastUsedAt: null,
        expiresAt: null,
      })
      expect(list[1].expiresAt?.toISOString()).toBe(later(30 * DAY).toISOString())
      const text = JSON.stringify(list)
      for (const token of [old.token, fresh.token]) {
        expect(text).not.toContain(token)
        expect(text).not.toContain(hashApiToken(SECRET, token))
      }
    })
  })

  describe("the limit", () => {
    it(`allows ${MAX_ACTIVE_API_TOKENS} active tokens and refuses one more`, async () => {
      for (let i = 0; i < MAX_ACTIVE_API_TOKENS; i++) await create({ name: `token ${i}` })
      expect(await createApiToken(database.db, SECRET, plain, T0)).toEqual({ ok: false, reason: "limit" })
      expect(await database.db.select().from(apiTokens)).toHaveLength(MAX_ACTIVE_API_TOKENS)
    })

    it("frees a place when a token is revoked or has expired", async () => {
      const first = await create({ expiresInDays: 30 })
      for (let i = 1; i < MAX_ACTIVE_API_TOKENS; i++) await create()
      expect((await createApiToken(database.db, SECRET, plain, T0)).ok).toBe(false)

      // Thirty days on, the first token has expired and no longer counts.
      expect((await createApiToken(database.db, SECRET, plain, later(30 * DAY))).ok).toBe(true)
      expect((await createApiToken(database.db, SECRET, plain, later(30 * DAY))).ok).toBe(false)

      const [someone] = (await listApiTokens(database.db)).filter((t) => t.id !== first.id)
      await revokeApiToken(database.db, someone.id)
      expect((await createApiToken(database.db, SECRET, plain, later(30 * DAY))).ok).toBe(true)
    })

    it("holds when many tokens are created at the same moment", async () => {
      const results = await Promise.all(Array.from({ length: MAX_ACTIVE_API_TOKENS + 5 }, (_, i) => createApiToken(database.db, SECRET, { ...plain, name: `t${i}` }, T0)))
      expect(results.filter((r) => r.ok)).toHaveLength(MAX_ACTIVE_API_TOKENS)
      expect(await database.db.select().from(apiTokens)).toHaveLength(MAX_ACTIVE_API_TOKENS)
    })
  })

  describe("the call log", () => {
    it("keeps 30 days of calls", async () => {
      const { id } = await create()
      await database.db.insert(apiCalls).values([
        { tokenId: id, at: later(-31 * DAY), tool: "get_metrics", ok: true, durationMs: 12 },
        { tokenId: id, at: later(-29 * DAY), tool: "list_apps", ok: false, durationMs: 3 },
      ])
      await purgeOldApiCalls(database.db, T0)
      const left = await database.db.select({ tool: apiCalls.tool }).from(apiCalls)
      expect(left).toEqual([{ tool: "list_apps" }])
    })

    it("goes with its token when the token is deleted", async () => {
      const { id } = await create()
      await database.db.insert(apiCalls).values({ tokenId: id, tool: "get_metrics", ok: true, durationMs: 5 })
      await database.db.delete(apiTokens).where(eq(apiTokens.id, id))
      expect(await database.db.select().from(apiCalls)).toHaveLength(0)
    })
  })
})
