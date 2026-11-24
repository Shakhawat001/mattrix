import { and, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm"
import { hmacHex, randomToken } from "@/lib/crypto"
import type { Db } from "@/lib/db/client"
import { apiCalls, apiTokens } from "@/lib/db/schema"

// API tokens let AI agents read the numbers without a browser session. A token is 256 random
// bits behind an `amt_` prefix, shown once when it is made. As with sessions, the table stores
// only an HMAC of it keyed with SESSION_SECRET, so a copy of the database cannot be used to read
// anything. A token can expire, can be revoked at any moment, and records when it was last used.

export const API_TOKEN_PREFIX = "amt_"
export const MAX_ACTIVE_API_TOKENS = 20
export const KEEP_API_CALLS_DAYS = 30

const DAY_MS = 86_400_000
const TOKEN_SHAPE = /^amt_[\w-]{43}$/
const TOUCH_AFTER_MS = 60_000

export const generateApiToken = (): string => `${API_TOKEN_PREFIX}${randomToken(32)}`

/** Whether a value could be a token at all, checked before anything reads the database. */
export const isApiTokenShape = (value: string): boolean => TOKEN_SHAPE.test(value)

export const hashApiToken = (secret: string, token: string): string => hmacHex(secret, token)

/** Not revoked, and not past its expiry. */
const activeAt = (now: Date) => and(isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)))

export type NewApiToken = { name: string; expiresInDays: number | null; hideShops: boolean }
export type CreatedApiToken = { ok: true; id: string; token: string } | { ok: false; reason: "limit" }

/** Makes a token and returns it, the only time it is ever seen. Refuses past the limit of active tokens. */
export async function createApiToken(db: Db, secret: string, input: NewApiToken, now: Date = new Date()): Promise<CreatedApiToken> {
  const token = generateApiToken()
  return db.transaction(async (tx): Promise<CreatedApiToken> => {
    // One at a time, so two requests at once cannot both take the last slot. The two-key form
    // keeps this lock apart from the single-key locks the sync and the migrations take.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('appmetrics'), hashtext('api-tokens'))`)
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(apiTokens).where(activeAt(now))
    if (n >= MAX_ACTIVE_API_TOKENS) return { ok: false, reason: "limit" }

    const [row] = await tx
      .insert(apiTokens)
      .values({
        name: input.name,
        tokenHash: hashApiToken(secret, token),
        hint: token.slice(-4),
        hideShops: input.hideShops,
        createdAt: now,
        expiresAt: input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * DAY_MS),
      })
      .returning({ id: apiTokens.id })
    return { ok: true, id: row.id, token }
  })
}

export type ApiCaller = { id: string; name: string; hideShops: boolean }

/** Who a token belongs to, or null if it is unknown, revoked or expired. Marks it used, at most once a minute. */
export async function verifyApiToken(db: Db, secret: string, token: string, now: Date = new Date()): Promise<ApiCaller | null> {
  if (!isApiTokenShape(token)) return null
  const [row] = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      hideShops: apiTokens.hideShops,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hashApiToken(secret, token)))
    .limit(1)
  if (!row || row.revokedAt !== null) return null
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null

  const touchBefore = new Date(now.getTime() - TOUCH_AFTER_MS)
  if (row.lastUsedAt === null || row.lastUsedAt.getTime() <= touchBefore.getTime()) {
    // The condition is repeated in the query, so requests that arrive together write it once.
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(and(eq(apiTokens.id, row.id), or(isNull(apiTokens.lastUsedAt), lte(apiTokens.lastUsedAt, touchBefore))))
  }
  return { id: row.id, name: row.name, hideShops: row.hideShops }
}

export type ApiTokenSummary = {
  id: string
  name: string
  hint: string
  hideShops: boolean
  createdAt: Date
  lastUsedAt: Date | null
  expiresAt: Date | null
}

/** Every token that has not been revoked, newest first, expired ones included. Never the hash. */
export async function listApiTokens(db: Db): Promise<ApiTokenSummary[]> {
  return db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      hint: apiTokens.hint,
      hideShops: apiTokens.hideShops,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
    })
    .from(apiTokens)
    .where(isNull(apiTokens.revokedAt))
    .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
}

/** Ends a token for good. False when there was no such token, or it was already revoked. */
export async function revokeApiToken(db: Db, id: string, now: Date = new Date()): Promise<boolean> {
  const revoked = await db
    .update(apiTokens)
    .set({ revokedAt: now })
    .where(and(eq(apiTokens.id, id), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id })
  return revoked.length > 0
}

/** The worker's hourly tidy-up: the call log keeps 30 days. */
export async function purgeOldApiCalls(db: Db, now: Date = new Date()): Promise<void> {
  await db.delete(apiCalls).where(lt(apiCalls.at, new Date(now.getTime() - KEEP_API_CALLS_DAYS * DAY_MS)))
}
